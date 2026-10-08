/**
 * Stripe Tax engine (docs/plans/weldbooks-us.md §3, phase 3.1).
 *
 * Uses the customer's own Stripe account (a restricted key). Calculations work
 * without Stripe payments; WeldBooks builds its returns from its own
 * `tax_lines`, so `commit` is only for customers who let Stripe file for them.
 * Stripe calculates only where the account has a registration, and answers
 * `not_collecting` elsewhere; the WeldBooks registration rule runs first, so
 * nothing is sent for a state the entity isn't registered in.
 *
 * https://docs.stripe.com/api/tax/calculations/create
 */

import { getUsState } from '../jurisdictions/us/states';
import {
  activeRegistrations,
  applyOverride,
  buildResult,
  certificateForSale,
  isUsCountry,
  jurisdictionCodeFor,
  stateHasNoSalesTax,
  untaxedLine,
  untaxedResult,
} from './common';
import { isoDay } from './dates';
import {
  callProvider,
  defaultFetch,
  formEncode,
  type FetchLike,
  type TaxCodeMapper,
} from './provider-common';
import { defaultStripeTaxCode } from './provider-tax-codes';
import { fromCents, snap6, toCents } from './rounding';
import { decideSourcing } from './sourcing';
import {
  SalesTaxEngineError,
  type JurisdictionLevel,
  type ProviderRegistration,
  type ReverseLine,
  type SalesTaxDetail,
  type SalesTaxEngine,
  type SalesTaxLineResult,
  type SalesTaxRequest,
  type SalesTaxResult,
  type SalesTaxWarning,
} from './types';

export const STRIPE_TAX_API_VERSION = '2025-11-17.clover';
const STRIPE_ORIGIN = 'https://api.stripe.com';
const TAX_DATE_WINDOW_HOURS = 47;

export interface StripeTaxOptions {
  apiKey: string;
  fetch?: FetchLike;
  mapTaxCode?: TaxCodeMapper;
  now?: () => Date;
  timeoutMs?: number;
}

interface StripeJurisdiction {
  country?: string;
  display_name?: string;
  level?: string;
  state?: string | null;
}

interface StripeBreakdownItem {
  amount?: number;
  jurisdiction?: StripeJurisdiction;
  sourcing?: 'origin' | 'destination';
  tax_rate_details?: { percentage_decimal?: string; display_name?: string; tax_type?: string | null };
  taxability_reason?: string;
  taxable_amount?: number;
}

interface StripeLineItem {
  id?: string;
  amount?: number;
  amount_tax?: number;
  reference?: string | null;
  tax_behavior?: 'exclusive' | 'inclusive';
  tax_breakdown?: StripeBreakdownItem[] | null;
}

interface StripeCalculation {
  id?: string;
  line_items?: { data?: StripeLineItem[] };
}

interface StripeList<T> {
  data?: T[];
  has_more?: boolean;
}

interface StripeTransaction {
  id?: string;
}

interface StripeRegistration {
  id: string;
  country?: string;
  status?: string;
  country_options?: { us?: { state?: string; type?: string } };
}

/** Stripe applies a calculation's tax date only within two days of now; older invoices get today's rates. */
function taxDateInWindow(date: string, now: Date): boolean {
  const at = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(at) && Math.abs(at - now.getTime()) <= TAX_DATE_WINDOW_HOURS * 3_600_000;
}

function mapLevel(level: string | undefined): JurisdictionLevel {
  return level === 'county' || level === 'city' || level === 'district' ? level : 'state';
}

export function createStripeTaxEngine(options: StripeTaxOptions): SalesTaxEngine {
  const fetchImpl = options.fetch ?? defaultFetch();
  const mapTaxCode = options.mapTaxCode ?? defaultStripeTaxCode;
  const now = options.now ?? (() => new Date());

  function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    return callProvider<T>({
      provider: 'Stripe Tax',
      fetch: fetchImpl,
      url: `${STRIPE_ORIGIN}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Stripe-Version': STRIPE_TAX_API_VERSION,
        ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...extraHeaders,
      },
      body,
      timeoutMs: options.timeoutMs,
    });
  }

  function buildCalculation(req: SalesTaxRequest, date: string, exempt: boolean, sent: number[]): string {
    const fields: Array<[string, string | number | boolean | undefined]> = [
      ['currency', req.currency.toLowerCase()],
      ['customer_details[address_source]', 'shipping'],
    ];
    const to = req.shipTo ?? {};
    const toState = decideSourcing({ shipFrom: req.shipFrom, shipTo: req.shipTo })?.taxingState;
    fields.push(
      ['customer_details[address][line1]', to.line1 || undefined],
      ['customer_details[address][line2]', to.line2 || undefined],
      ['customer_details[address][city]', to.city || undefined],
      ['customer_details[address][state]', toState],
      ['customer_details[address][postal_code]', to.postalCode?.trim() || undefined],
      ['customer_details[address][country]', 'US'],
    );
    if (exempt) fields.push(['customer_details[taxability_override]', 'customer_exempt']);

    const from = req.shipFrom;
    const fromState = from.state?.trim();
    if (fromState && from.postalCode) {
      fields.push(
        ['ship_from_details[address][line1]', from.line1 || undefined],
        ['ship_from_details[address][city]', from.city || undefined],
        ['ship_from_details[address][state]', fromState.toUpperCase()],
        ['ship_from_details[address][postal_code]', from.postalCode.trim()],
        ['ship_from_details[address][country]', 'US'],
      );
    }

    sent.forEach((lineIndex, n) => {
      const l = req.lines[lineIndex];
      fields.push(
        [`line_items[${n}][amount]`, toCents(l.amount)],
        [`line_items[${n}][reference]`, l.lineId],
        [`line_items[${n}][tax_code]`, mapTaxCode(l.taxCode, l.use ?? req.customer.use ?? 'business')],
        [`line_items[${n}][tax_behavior]`, l.taxIncluded ? 'inclusive' : 'exclusive'],
      );
      if (Number.isInteger(l.quantity) && l.quantity >= 1) fields.push([`line_items[${n}][quantity]`, l.quantity]);
    });

    if (taxDateInWindow(date, now())) {
      fields.push(['tax_date', Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000)]);
    }
    fields.push(['expand[0]', 'line_items.data.tax_breakdown']);
    return formEncode(fields);
  }

  async function calculate(req: SalesTaxRequest): Promise<SalesTaxResult> {
    const calculatedAt = now().toISOString();
    if ((req.direction ?? 'sales') === 'use') {
      throw new SalesTaxEngineError(
        'Stripe Tax calculates sales tax only; use tax needs the manual or the Avalara engine',
        'invalid_request',
      );
    }
    const decision = decideSourcing({ shipFrom: req.shipFrom, shipTo: req.shipTo });
    if (!decision) return untaxedResult('stripe_tax', req, ['no_ship_to'], calculatedAt);
    const state = decision.taxingState;
    if (req.marketplaceFacilitated) {
      return untaxedResult('stripe_tax', req, ['marketplace_facilitated'], calculatedAt, state);
    }
    if (!isUsCountry(req.shipTo)) return untaxedResult('stripe_tax', req, [], calculatedAt);

    const date = isoDay(req.documentDate);
    const registered = activeRegistrations(req.registrations, state, date);
    if (registered.length === 0) {
      return untaxedResult(
        'stripe_tax',
        req,
        stateHasNoSalesTax(state) ? [] : ['not_registered_in_state'],
        calculatedAt,
        state,
      );
    }
    for (const l of req.lines) {
      if (l.amount < 0) {
        throw new SalesTaxEngineError(
          'Stripe Tax cannot calculate a negative amount; a credit memo reuses the original invoice tax',
          'invalid_request',
        );
      }
    }

    const warnings = new Set<SalesTaxWarning>();
    const { certificate, warning } = certificateForSale(req, state, date);
    if (warning) warnings.add(warning);

    const sent = req.lines.map((_, i) => i).filter((i) => toCents(req.lines[i].amount) > 0);
    const results = new Map<string, SalesTaxLineResult>();
    let engineRef: string | undefined;
    const sourcings = new Set<string>();

    if (sent.length > 0) {
      const body = buildCalculation(req, date, Boolean(certificate), sent);
      const calc = await call<StripeCalculation>('POST', '/v1/tax/calculations', body);
      engineRef = calc.id;
      if (!taxDateInWindow(date, now())) warnings.add('provider_rate_date_ignored');
      const agencyId = registered.find((r) => r.level === 'state')?.agencyId ?? registered[0].agencyId;
      for (const item of calc.line_items?.data ?? []) {
        const mapped = mapLine(item, {
          req,
          state,
          agencyId,
          certificate,
          warnings,
          sourcings,
        });
        if (mapped) results.set(mapped.lineId, mapped);
      }
    }

    const lines = req.lines.map((l) => {
      let result = results.get(l.lineId) ?? untaxedLine(l);
      if (l.override) {
        const overridden = applyOverride(result, l.override);
        if (!overridden.applied) warnings.add('override_not_applied');
        result = overridden.line;
      }
      return result;
    });

    const sourcing =
      sourcings.size === 0
        ? decision.sourcing
        : sourcings.size === 2
          ? 'modified_origin'
          : sourcings.has('origin')
            ? 'origin'
            : 'destination';
    return buildResult('stripe_tax', req, { sourcing, lines, warnings, engineRef, shipToState: state, calculatedAt });
  }

  async function commit(req: SalesTaxRequest, result: SalesTaxResult): Promise<{ ref: string }> {
    const reference = req.documentNumber ?? req.documentId;
    if (!reference) throw new SalesTaxEngineError('A document number is needed to record a Stripe transaction', 'invalid_request');
    if (!result.engineRef?.startsWith('taxcalc_')) {
      throw new SalesTaxEngineError('The calculation has no Stripe reference to record', 'invalid_request');
    }
    const body = formEncode([
      ['calculation', result.engineRef],
      ['reference', reference],
    ]);
    const txn = await call<StripeTransaction>('POST', '/v1/tax/transactions/create_from_calculation', body, {
      'Idempotency-Key': `weldbooks-tax-commit-${result.engineRef}`,
    });
    if (!txn.id) throw new SalesTaxEngineError('Stripe returned no transaction id', 'unreachable', true);
    return { ref: txn.id };
  }

  async function originalLineItems(ref: string): Promise<StripeLineItem[]> {
    const items: StripeLineItem[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ limit: '100' });
      if (startingAfter) query.set('starting_after', startingAfter);
      const list = await call<StripeList<StripeLineItem>>(
        'GET',
        `/v1/tax/transactions/${encodeURIComponent(ref)}/line_items?${query.toString()}`,
      );
      const data = list.data ?? [];
      items.push(...data);
      if (!list.has_more || data.length === 0) break;
      startingAfter = data[data.length - 1].id;
    }
    return items;
  }

  async function reverse(
    ref: string,
    lines: ReverseLine[],
    opts: { documentNumber: string; date: string },
  ): Promise<{ ref: string }> {
    const originals = await originalLineItems(ref);
    const fields: Array<[string, string | number | boolean | undefined]> = [
      ['mode', 'partial'],
      ['original_transaction', ref],
      ['reference', opts.documentNumber],
      ['metadata[document_date]', isoDay(opts.date)],
    ];
    lines.forEach((line, n) => {
      const original = originals.find((o) => o.reference === line.lineId);
      if (!original?.id) {
        throw new SalesTaxEngineError(`Line ${line.lineId} is not on Stripe transaction ${ref}`, 'invalid_request');
      }
      const tax = toCents(line.tax);
      // An inclusive line's amount holds its tax.
      const amount = toCents(line.amount) + (original.tax_behavior === 'inclusive' ? tax : 0);
      fields.push(
        [`line_items[${n}][amount]`, -amount],
        [`line_items[${n}][amount_tax]`, -tax],
        [`line_items[${n}][original_line_item]`, original.id],
        [`line_items[${n}][reference]`, `${opts.documentNumber}:${line.lineId}`],
      );
    });
    const txn = await call<StripeTransaction>('POST', '/v1/tax/transactions/create_reversal', formEncode(fields), {
      'Idempotency-Key': `weldbooks-tax-reverse-${ref}-${opts.documentNumber}`,
    });
    if (!txn.id) throw new SalesTaxEngineError('Stripe returned no transaction id', 'unreachable', true);
    return { ref: txn.id };
  }

  /** Stripe has no void: a full reversal takes the transaction out of the filing. */
  async function voidTransaction(ref: string): Promise<void> {
    const body = formEncode([
      ['mode', 'full'],
      ['original_transaction', ref],
      ['reference', `void-${ref}`],
    ]);
    await call<StripeTransaction>('POST', '/v1/tax/transactions/create_reversal', body, {
      'Idempotency-Key': `weldbooks-tax-void-${ref}`,
    });
  }

  async function listRegistrations(): Promise<ProviderRegistration[]> {
    const out: ProviderRegistration[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ status: 'active', limit: '100' });
      if (startingAfter) query.set('starting_after', startingAfter);
      const list = await call<StripeList<StripeRegistration>>('GET', `/v1/tax/registrations?${query.toString()}`);
      const data = list.data ?? [];
      for (const r of data) {
        const us = r.country_options?.us;
        if (r.country !== 'US' || !us?.state) continue;
        if (us.type && us.type !== 'state_sales_tax') continue;
        out.push({ stateCode: us.state.toUpperCase(), ref: r.id, active: r.status === 'active' });
      }
      if (!list.has_more || data.length === 0) break;
      startingAfter = data[data.length - 1].id;
    }
    return out;
  }

  return { id: 'stripe_tax', calculate, commit, reverse, void: voidTransaction, listRegistrations };
}

interface MapContext {
  req: SalesTaxRequest;
  state: string;
  agencyId: string;
  certificate?: { id: string; reason: string };
  warnings: Set<SalesTaxWarning>;
  sourcings: Set<string>;
}

/** One Stripe line item to a line result; null when it isn't one of ours. */
function mapLine(item: StripeLineItem, ctx: MapContext): SalesTaxLineResult | null {
  const lineId = item.reference;
  if (!lineId) return null;
  const inclusive = item.tax_behavior === 'inclusive';
  const amountTax = item.amount_tax ?? 0;
  const gross = fromCents((item.amount ?? 0) - (inclusive ? amountTax : 0));
  const breakdown = item.tax_breakdown ?? [];

  if (breakdown.some((b) => b.taxability_reason === 'not_collecting')) {
    ctx.warnings.add('not_registered_in_state');
    return { lineId, grossAmount: gross, taxableAmount: 0, exemptAmount: 0, nonTaxableAmount: gross, tax: 0, details: [] };
  }

  const exempt = Boolean(ctx.certificate);
  const seen = new Map<string, number>();
  const all: SalesTaxDetail[] = breakdown.map((b) => {
    if (b.taxability_reason === 'not_supported') ctx.warnings.add('provider_not_supported');
    if (b.sourcing) ctx.sourcings.add(b.sourcing);
    const level = mapLevel(b.jurisdiction?.level);
    const stateCode = (b.jurisdiction?.state ?? ctx.state).toUpperCase();
    const name = b.jurisdiction?.display_name ?? b.tax_rate_details?.display_name ?? stateCode;
    const rate = Number(b.tax_rate_details?.percentage_decimal ?? 0) || 0;
    const taxable = fromCents(b.taxable_amount ?? 0);
    const tax = fromCents(b.amount ?? 0);
    const customerExempt = exempt || b.taxability_reason === 'customer_exempt';
    const exemptAmount = customerExempt ? Math.max(0, fromCents(toCents(gross) - toCents(taxable))) : 0;
    const nonTaxable = Math.max(0, fromCents(toCents(gross) - toCents(taxable) - toCents(exemptAmount)));

    const base = jurisdictionCodeFor(stateCode, level, name);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const code = count > 0 ? jurisdictionCodeFor(stateCode, level, name, String(rate)) : base;

    return {
      jurisdictionCode: code,
      jurisdictionName: name,
      level,
      stateCode,
      agencyId: ctx.agencyId,
      rate,
      taxableAmount: taxable,
      exemptAmount,
      nonTaxableAmount: nonTaxable,
      tax,
      unroundedTax: rate > 0 ? snap6((taxable * rate) / 100) : tax,
      ...(exemptAmount > 0 && ctx.certificate
        ? { exemptReason: ctx.certificate.reason, certificateId: ctx.certificate.id }
        : {}),
    };
  });

  // A jurisdiction that is taxable at 0% says nothing the others don't; keep it only when it is all there is.
  const informative = all.filter(
    (d) => !(d.rate === 0 && d.tax === 0 && d.exemptAmount === 0 && d.nonTaxableAmount === 0),
  );
  const details = informative.length > 0 ? informative : all.slice(0, 1);

  if (details.length === 0) {
    // Nothing came back for the line: keep it on the ledger as a sale in the state.
    const info = getUsState(ctx.state);
    details.push({
      jurisdictionCode: ctx.state,
      jurisdictionName: info?.name ?? ctx.state,
      level: 'state',
      stateCode: ctx.state,
      agencyId: ctx.agencyId,
      rate: 0,
      taxableAmount: 0,
      exemptAmount: exempt ? gross : 0,
      nonTaxableAmount: exempt ? 0 : gross,
      tax: 0,
      unroundedTax: 0,
      ...(exempt && ctx.certificate ? { exemptReason: ctx.certificate.reason, certificateId: ctx.certificate.id } : {}),
    });
  }

  const first = details[0];
  const tax = fromCents(details.reduce((sum, d) => sum + toCents(d.tax), 0));
  return {
    lineId,
    grossAmount: gross,
    taxableAmount: first.taxableAmount,
    exemptAmount: first.exemptAmount,
    nonTaxableAmount: first.nonTaxableAmount,
    tax,
    details,
  };
}
