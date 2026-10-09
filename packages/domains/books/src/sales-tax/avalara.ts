/**
 * Avalara AvaTax engine (docs/plans/weldbooks-us.md §3, phase 3.2).
 *
 * The customer's own account id and license key (HTTP Basic). `calculate`
 * creates a temporary SalesOrder (PurchaseOrder for use tax); `commit` records
 * the finalized document as a SalesInvoice; `reverse` refunds against it and
 * `void` voids it. The WeldBooks registration rule runs before any call, so
 * nothing is sent for a state the entity isn't registered in.
 *
 * https://developer.avalara.com/api-reference/avatax/rest/v2/
 */

import type { PostalAddress } from '@weldsuite/db/schema';
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
  toBase64,
  type FetchLike,
  type TaxCodeMapper,
} from './provider-common';
import { defaultAvalaraTaxCode } from './provider-tax-codes';
import { fromCents, snap6, toCents } from './rounding';
import { decideSourcing, stateCodeOf } from './sourcing';
import { getUsState } from '../jurisdictions/us/states';
import {
  SalesTaxEngineError,
  type AddressValidation,
  type ExemptReason,
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

export interface AvalaraOptions {
  accountId: string;
  licenseKey: string;
  companyCode: string;
  environment: 'sandbox' | 'production';
  fetch?: FetchLike;
  mapTaxCode?: TaxCodeMapper;
  now?: () => Date;
  timeoutMs?: number;
}

export const AVALARA_BASE_URL = {
  sandbox: 'https://sandbox-rest.avatax.com',
  production: 'https://rest.avatax.com',
} as const;

/** Avalara entity/use codes for a certificate's reason (the customer's tax-exempt status). */
export const AVALARA_ENTITY_USE_CODE: Record<ExemptReason, string> = {
  resale: 'G',
  nonprofit: 'E',
  government: 'B',
  manufacturing: 'I',
  agricultural: 'H',
  other: 'L',
};

interface AvalaraDetail {
  jurisType?: string;
  jurisCode?: string;
  jurisName?: string;
  region?: string;
  rate?: number;
  taxableAmount?: number;
  exemptAmount?: number;
  nonTaxableAmount?: number;
  tax?: number;
  stateAssignedNo?: string | null;
}

interface AvalaraLine {
  lineNumber?: string;
  lineAmount?: number;
  taxIncluded?: boolean;
  tax?: number;
  details?: AvalaraDetail[] | null;
}

interface AvalaraTransaction {
  id?: number;
  code?: string;
  date?: string;
  lines?: AvalaraLine[] | null;
}

interface AvalaraAddressMessage {
  summary?: string;
  details?: string;
  severity?: string;
}

interface AvalaraResolution {
  validatedAddresses?: Array<{
    line1?: string;
    line2?: string;
    city?: string;
    region?: string;
    country?: string;
    postalCode?: string;
  }> | null;
  messages?: AvalaraAddressMessage[] | null;
}

interface AvalaraFetchResult<T> {
  value?: T[];
}

interface AvalaraNexus {
  id?: number;
  country?: string;
  region?: string;
  jurisTypeId?: string;
  nexusTypeId?: string;
  effectiveDate?: string | null;
  endDate?: string | null;
}

function mapLevel(jurisType: string | undefined): JurisdictionLevel | null {
  switch (jurisType) {
    case 'STA':
      return 'state';
    case 'CTY':
      return 'county';
    case 'CIT':
      return 'city';
    case 'CNT':
      return null;
    default:
      return 'district';
  }
}

function avalaraAddress(a: PostalAddress): Record<string, string> {
  const out: Record<string, string> = { country: 'US' };
  if (a.line1) out.line1 = a.line1;
  if (a.line2) out.line2 = a.line2;
  if (a.city) out.city = a.city;
  const state = stateCodeOf(a);
  if (state) out.region = state;
  if (a.postalCode) out.postalCode = a.postalCode.trim();
  return out;
}

/** The ref of a committed transaction: the document code, prefixed for a use tax (purchase) document. */
const PURCHASE_PREFIX = 'PurchaseInvoice:';

function parseRef(ref: string): { code: string; purchase: boolean } {
  return ref.startsWith(PURCHASE_PREFIX)
    ? { code: ref.slice(PURCHASE_PREFIX.length), purchase: true }
    : { code: ref, purchase: false };
}

export function createAvalaraEngine(options: AvalaraOptions): SalesTaxEngine {
  const fetchImpl = options.fetch ?? defaultFetch();
  const mapTaxCode = options.mapTaxCode ?? defaultAvalaraTaxCode;
  const now = options.now ?? (() => new Date());
  const baseUrl = AVALARA_BASE_URL[options.environment];
  const authorization = `Basic ${toBase64(`${options.accountId}:${options.licenseKey}`)}`;
  const company = encodeURIComponent(options.companyCode);
  let companyId: number | undefined;

  function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return callProvider<T>({
      provider: 'Avalara AvaTax',
      fetch: fetchImpl,
      url: `${baseUrl}${path}`,
      method,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        'X-Avalara-Client': 'WeldBooks; 1.0; WeldSuite; 1.0; weldsuite',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      timeoutMs: options.timeoutMs,
    });
  }

  function documentBody(
    req: SalesTaxRequest,
    kind: { type: 'SalesOrder' | 'SalesInvoice' | 'PurchaseOrder' | 'PurchaseInvoice'; commit: boolean },
    date: string,
    state: string,
  ): Record<string, unknown> {
    const { certificate } = certificateForSale(req, state, date);
    const lines = req.lines.map((l) => {
      const taxCode = mapTaxCode(l.taxCode, l.use ?? req.customer.use ?? 'business');
      return {
        number: l.lineId,
        quantity: l.quantity,
        amount: l.amount,
        taxCode,
        taxIncluded: Boolean(l.taxIncluded),
        description: l.lineId,
        ...(kind.commit && l.override
          ? { taxOverride: { type: 'taxAmount', taxAmount: l.override.amount, reason: l.override.reason } }
          : {}),
      };
    });
    return {
      type: kind.type,
      companyCode: options.companyCode,
      date,
      customerCode: req.customer.partyId,
      currencyCode: req.currency.toUpperCase(),
      commit: kind.commit,
      ...(kind.commit ? { code: req.documentNumber ?? req.documentId } : {}),
      ...(req.documentNumber ? { purchaseOrderNo: req.documentNumber } : {}),
      addresses: { shipFrom: avalaraAddress(req.shipFrom), shipTo: avalaraAddress(req.shipTo ?? {}) },
      ...(certificate
        ? {
            exemptionNo: certificate.certificateNumber || certificate.id,
            entityUseCode: AVALARA_ENTITY_USE_CODE[certificate.reason],
          }
        : {}),
      lines,
    };
  }

  async function calculate(req: SalesTaxRequest): Promise<SalesTaxResult> {
    const calculatedAt = now().toISOString();
    const direction = req.direction ?? 'sales';
    const decision = decideSourcing({ shipFrom: req.shipFrom, shipTo: req.shipTo, direction });
    if (!decision) return untaxedResult('avalara', req, ['no_ship_to'], calculatedAt);
    const state = decision.taxingState;
    if (req.marketplaceFacilitated) {
      return untaxedResult('avalara', req, ['marketplace_facilitated'], calculatedAt, state);
    }
    if (!isUsCountry(req.shipTo)) return untaxedResult('avalara', req, [], calculatedAt);

    const date = isoDay(req.documentDate);
    const warnings = new Set<SalesTaxWarning>();
    const registered = activeRegistrations(req.registrations, state, date);
    if (direction === 'sales' && registered.length === 0) {
      return untaxedResult(
        'avalara',
        req,
        stateHasNoSalesTax(state) ? [] : ['not_registered_in_state'],
        calculatedAt,
        state,
      );
    }
    if (direction === 'use' && registered.length === 0) warnings.add('no_use_tax_registration');

    const certificateResult = direction === 'sales' ? certificateForSale(req, state, date) : {};
    if (certificateResult.warning) warnings.add(certificateResult.warning);

    const body = documentBody(
      direction === 'use' ? { ...req, customer: { ...req.customer, certificates: [] } } : req,
      { type: direction === 'use' ? 'PurchaseOrder' : 'SalesOrder', commit: false },
      date,
      state,
    );
    const tx = await call<AvalaraTransaction>('POST', '/api/v2/transactions/create', body);

    const agencyId = registered.find((r) => r.level === 'state')?.agencyId ?? registered[0]?.agencyId;
    const byNumber = new Map((tx.lines ?? []).map((l) => [l.lineNumber ?? '', l]));
    const lines = req.lines.map((l) => {
      const mapped = byNumber.get(l.lineId);
      let result = mapped
        ? mapLine(l.lineId, mapped, { state, agencyId, certificate: certificateResult.certificate, warnings })
        : untaxedLine(l);
      if (l.override) {
        const overridden = applyOverride(result, l.override);
        if (!overridden.applied) warnings.add('override_not_applied');
        result = overridden.line;
      }
      return result;
    });

    return buildResult('avalara', req, {
      sourcing: decision.sourcing,
      lines,
      warnings,
      engineRef: tx.code,
      shipToState: state,
      calculatedAt,
    });
  }

  async function commit(req: SalesTaxRequest): Promise<{ ref: string }> {
    const code = req.documentNumber ?? req.documentId;
    if (!code) throw new SalesTaxEngineError('A document number is needed to record an Avalara transaction', 'invalid_request');
    const direction = req.direction ?? 'sales';
    const decision = decideSourcing({ shipFrom: req.shipFrom, shipTo: req.shipTo, direction });
    if (!decision) throw new SalesTaxEngineError('A ship-to address is needed to record an Avalara transaction', 'invalid_request');
    const date = isoDay(req.documentDate);
    const body = documentBody(
      direction === 'use' ? { ...req, customer: { ...req.customer, certificates: [] } } : req,
      { type: direction === 'use' ? 'PurchaseInvoice' : 'SalesInvoice', commit: true },
      date,
      decision.taxingState,
    );
    const tx = await call<AvalaraTransaction>('POST', '/api/v2/transactions/create', body);
    const saved = tx.code ?? code;
    return { ref: direction === 'use' ? `${PURCHASE_PREFIX}${saved}` : saved };
  }

  async function reverse(
    ref: string,
    lines: ReverseLine[],
    opts: { documentNumber: string; date: string },
  ): Promise<{ ref: string }> {
    const { code, purchase } = parseRef(ref);
    if (purchase) {
      throw new SalesTaxEngineError('A use tax transaction cannot be refunded; void it and record it again', 'invalid_request');
    }
    const original = await call<AvalaraTransaction>(
      'GET',
      `/api/v2/companies/${company}/transactions/${encodeURIComponent(code)}?documentType=SalesInvoice&%24include=Lines`,
    );
    const originalLines = original.lines ?? [];
    if (originalLines.length === 0) {
      throw new SalesTaxEngineError(`Avalara transaction ${code} has no lines to refund`, 'invalid_request');
    }

    // Avalara refunds whole lines, or one percentage of the whole document.
    const grossOf = (l: AvalaraLine): number => (l.lineAmount ?? 0) - (l.taxIncluded ? (l.tax ?? 0) : 0);
    const ratios = new Map<string, number>();
    for (const credit of lines) {
      const orig = originalLines.find((o) => o.lineNumber === credit.lineId);
      if (!orig) throw new SalesTaxEngineError(`Line ${credit.lineId} is not on Avalara transaction ${code}`, 'invalid_request');
      const base = grossOf(orig);
      ratios.set(credit.lineId, base === 0 ? 1 : credit.amount / base);
    }
    const whole = lines.every((c) => Math.abs((ratios.get(c.lineId) ?? 0) - 1) < 0.0005);
    const sameRatio =
      lines.length === originalLines.length &&
      lines.every((c) => Math.abs((ratios.get(c.lineId) ?? 0) - (ratios.get(lines[0].lineId) ?? 0)) < 0.0005);

    let refund: Record<string, unknown>;
    if (whole && lines.length === originalLines.length) {
      refund = { refundType: 'Full' };
    } else if (whole) {
      refund = { refundType: 'Partial', refundLines: lines.map((c) => c.lineId) };
    } else if (sameRatio) {
      refund = { refundType: 'Percentage', refundPercentage: Math.round((ratios.get(lines[0].lineId) ?? 0) * 10000) / 100 };
    } else {
      throw new SalesTaxEngineError(
        'Avalara refunds whole lines or one percentage of the document; void the transaction and record it again to credit part of a line',
        'invalid_request',
      );
    }

    const refunded = await call<AvalaraTransaction>(
      'POST',
      `/api/v2/companies/${company}/transactions/${encodeURIComponent(code)}/refund?documentType=SalesInvoice`,
      {
        refundTransactionCode: opts.documentNumber,
        refundDate: isoDay(opts.date),
        ...(original.date ? { refundTaxDate: isoDay(original.date) } : {}),
        referenceCode: code,
        ...refund,
      },
    );
    return { ref: refunded.code ?? opts.documentNumber };
  }

  async function voidTransaction(ref: string): Promise<void> {
    const { code, purchase } = parseRef(ref);
    await call(
      'POST',
      `/api/v2/companies/${company}/transactions/${encodeURIComponent(code)}/void?documentType=${purchase ? 'PurchaseInvoice' : 'SalesInvoice'}`,
      { code: 'DocVoided' },
    );
  }

  async function validateAddress(address: PostalAddress): Promise<AddressValidation> {
    const resolution = await call<AvalaraResolution>('POST', '/api/v2/addresses/resolve', {
      ...avalaraAddress(address),
      textCase: 'Mixed',
    });
    const messages = (resolution.messages ?? []).filter((m) => m.summary || m.details);
    const failed = messages.some((m) => m.severity === 'Error');
    const first = resolution.validatedAddresses?.[0];
    const text = messages.map((m) => m.summary ?? m.details ?? '').filter(Boolean);
    if (!first || failed) return { valid: false, ...(text.length ? { messages: text } : {}) };
    return {
      valid: true,
      normalized: {
        ...(first.line1 ? { line1: first.line1 } : {}),
        ...(first.line2 ? { line2: first.line2 } : {}),
        ...(first.city ? { city: first.city } : {}),
        ...(first.region ? { state: first.region } : {}),
        ...(first.postalCode ? { postalCode: first.postalCode } : {}),
        country: first.country ?? 'US',
      },
      ...(text.length ? { messages: text } : {}),
    };
  }

  async function resolveCompanyId(): Promise<number> {
    if (companyId !== undefined) return companyId;
    const filter = encodeURIComponent(`companyCode eq '${options.companyCode.replace(/'/g, "''")}'`);
    const found = await call<AvalaraFetchResult<{ id?: number }>>('GET', `/api/v2/companies?%24filter=${filter}&%24top=1`);
    const id = found.value?.[0]?.id;
    if (id === undefined) {
      throw new SalesTaxEngineError(`Avalara company ${options.companyCode} was not found`, 'invalid_request');
    }
    companyId = id;
    return id;
  }

  async function listRegistrations(): Promise<ProviderRegistration[]> {
    const id = await resolveCompanyId();
    const list = await call<AvalaraFetchResult<AvalaraNexus>>('GET', `/api/v2/companies/${id}/nexus?%24top=1000`);
    const today = isoDay(now());
    const out: ProviderRegistration[] = [];
    for (const n of list.value ?? []) {
      if (n.country !== 'US' || !n.region) continue;
      if ((n.jurisTypeId ?? 'STA') !== 'STA' || n.nexusTypeId === 'None') continue;
      const started = !n.effectiveDate || isoDay(n.effectiveDate) <= today;
      const open = !n.endDate || isoDay(n.endDate) >= today;
      out.push({ stateCode: n.region.toUpperCase(), ref: String(n.id ?? n.region), active: started && open });
    }
    return out;
  }

  return {
    id: 'avalara',
    calculate,
    commit,
    reverse,
    void: voidTransaction,
    validateAddress,
    listRegistrations,
  };
}

interface MapContext {
  state: string;
  agencyId?: string;
  certificate?: { id: string; reason: string };
  warnings: Set<SalesTaxWarning>;
}

function mapLine(lineId: string, line: AvalaraLine, ctx: MapContext): SalesTaxLineResult {
  const tax = line.tax ?? 0;
  const inclusive = Boolean(line.taxIncluded);
  const gross = fromCents(toCents(line.lineAmount ?? 0) - (inclusive ? toCents(tax) : 0));

  const details: SalesTaxDetail[] = [];
  for (const d of line.details ?? []) {
    const level = mapLevel(d.jurisType);
    if (!level) continue;
    const rate = Math.round((d.rate ?? 0) * 100 * 10000) / 10000;
    const taxable = d.taxableAmount ?? 0;
    const exempt = d.exemptAmount ?? 0;
    const detailTax = d.tax ?? 0;
    details.push({
      jurisdictionCode: d.jurisCode ?? jurisdictionCodeFor(d.region ?? ctx.state, level, d.jurisName ?? 'unknown'),
      jurisdictionName: d.jurisName ?? d.region ?? ctx.state,
      level,
      stateCode: (d.region ?? ctx.state).toUpperCase(),
      ...(ctx.agencyId ? { agencyId: ctx.agencyId } : {}),
      ...(d.stateAssignedNo ? { reportingCode: d.stateAssignedNo } : {}),
      rate,
      taxableAmount: taxable,
      exemptAmount: exempt,
      nonTaxableAmount: d.nonTaxableAmount ?? 0,
      tax: detailTax,
      unroundedTax: rate > 0 ? snap6((taxable * rate) / 100) : detailTax,
      ...(exempt > 0 && ctx.certificate
        ? { exemptReason: ctx.certificate.reason, certificateId: ctx.certificate.id }
        : {}),
    });
  }

  if (details.length === 0) {
    // The provider has no nexus where the entity is registered: keep the sale on the ledger, untaxed.
    ctx.warnings.add('provider_nexus_missing');
    const info = getUsState(ctx.state);
    details.push({
      jurisdictionCode: ctx.state,
      jurisdictionName: info?.name ?? ctx.state,
      level: 'state',
      stateCode: ctx.state,
      ...(ctx.agencyId ? { agencyId: ctx.agencyId } : {}),
      rate: 0,
      taxableAmount: 0,
      exemptAmount: 0,
      nonTaxableAmount: gross,
      tax: 0,
      unroundedTax: 0,
    });
  }

  const first = details[0];
  return {
    lineId,
    grossAmount: gross,
    taxableAmount: first.taxableAmount,
    exemptAmount: first.exemptAmount,
    nonTaxableAmount: first.nonTaxableAmount,
    tax: fromCents(details.reduce((sum, d) => sum + toCents(d.tax), 0)),
    details,
  };
}
