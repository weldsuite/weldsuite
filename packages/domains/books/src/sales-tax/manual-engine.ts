/**
 * The manual sales tax engine: rates, zones and taxability rules the user
 * keeps (docs/plans/weldbooks-us.md §3). Right for a business collecting in one
 * or two states; the UI says the rates are the user's responsibility.
 *
 * Per line and per agency it works out the taxable, exempt and non-taxable
 * parts, multiplies the taxable part by each jurisdiction's rate at the tax
 * point, and rounds per the state's rule. Tax is charged only where the
 * entity is registered on the document date.
 */

import {
  activeRegistrations,
  buildResult,
  certificateForSale,
  isUsCountry,
  spreadTax,
  stateHasNoSalesTax,
  untaxedLine,
  untaxedResult,
} from './common';
import { inRange, isoDay } from './dates';
import { fromCents, roundingFor, roundTaxCells, snap6, toCents, type TaxCell } from './rounding';
import { decideSourcing, zip5Of, type AddressSide, type SourcingDecision } from './sourcing';
import type {
  ExemptReason,
  JurisdictionLevel,
  ManualEngineData,
  ManualJurisdiction,
  ManualTaxabilityRule,
  ManualZone,
  SalesTaxDetail,
  SalesTaxEngine,
  SalesTaxLineResult,
  SalesTaxRegistration,
  SalesTaxRequest,
  SalesTaxRequestLine,
  SalesTaxResult,
  SalesTaxWarning,
  TaxUse,
} from './types';
import { pickDestinationZone, pickOriginZone } from './zones';

export interface ManualEngineOptions {
  /** Clock for `calculatedAt`; injected by tests. */
  now?: () => Date;
}

const LEVELS: JurisdictionLevel[] = ['state', 'county', 'city', 'district'];
const LEVEL_RANK: Record<JurisdictionLevel, number> = { state: 0, county: 1, city: 2, district: 3 };

interface DataIndex {
  byId: Map<string, ManualJurisdiction>;
  jurisdictionsByAgency: Map<string, ManualJurisdiction[]>;
  zonesByAgency: Map<string, ManualZone[]>;
  rulesByAgency: Map<string, ManualTaxabilityRule[]>;
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function indexData(data: ManualEngineData): DataIndex {
  const index: DataIndex = {
    byId: new Map(),
    jurisdictionsByAgency: new Map(),
    zonesByAgency: new Map(),
    rulesByAgency: new Map(),
  };
  for (const j of data.jurisdictions) {
    index.byId.set(j.id, j);
    pushTo(index.jurisdictionsByAgency, j.agencyId, j);
  }
  for (const z of data.zones) pushTo(index.zonesByAgency, z.agencyId, z);
  for (const r of data.rules) pushTo(index.rulesByAgency, r.agencyId, r);
  return index;
}

/** The rate in force on the tax point; null when the jurisdiction has none that day. */
function rateAt(jurisdiction: ManualJurisdiction, date: string): number | null {
  const rate = jurisdiction.rates
    .filter((r) => inRange(date, r.effectiveFrom, r.effectiveTo))
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0))[0];
  return rate ? Number(rate.rate) : null;
}

/** The rule that applies to a tax code for a use on the tax point; a rule for the use beats `any`, a later one beats an earlier. */
function ruleAt(
  rules: ManualTaxabilityRule[],
  taxCode: string,
  use: TaxUse,
  date: string,
): ManualTaxabilityRule | undefined {
  const code = taxCode.trim().toLowerCase();
  return rules
    .filter(
      (r) =>
        r.taxCode.trim().toLowerCase() === code &&
        (r.appliesToUse === 'any' || r.appliesToUse === use) &&
        inRange(date, r.effectiveFrom, r.effectiveTo),
    )
    .sort((a, b) => {
      const specific = Number(b.appliesToUse !== 'any') - Number(a.appliesToUse !== 'any');
      if (specific !== 0) return specific;
      return a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0;
    })[0];
}

interface PlannedJurisdiction {
  jurisdiction: ManualJurisdiction;
  rate: number;
}

interface AgencyPlan {
  agencyId: string;
  /** Details carry this agency id (use tax: only while registered). */
  reportAgencyId?: string;
  jurisdictions: PlannedJurisdiction[];
  rules: ManualTaxabilityRule[];
}

interface Context {
  req: SalesTaxRequest;
  date: string;
  decision: SourcingDecision;
  warnings: Set<SalesTaxWarning>;
}

/** The jurisdictions of one agency that apply to this sale, by sourcing level. */
function planAgency(
  index: DataIndex,
  agencyId: string,
  ctx: Context,
): { jurisdictions: PlannedJurisdiction[]; zoneMissing: boolean } {
  const zones = index.zonesByAgency.get(agencyId) ?? [];
  const all = index.jurisdictionsByAgency.get(agencyId) ?? [];
  const destZip = zip5Of(ctx.req.shipTo);
  const originZip = zip5Of(ctx.req.shipFrom);

  const zoneBySide = new Map<AddressSide, ManualZone | undefined>();
  const zoneFor = (side: AddressSide): ManualZone | undefined => {
    if (!zoneBySide.has(side)) {
      zoneBySide.set(side, side === 'origin' ? pickOriginZone(zones, originZip) : pickDestinationZone(zones, destZip));
    }
    return zoneBySide.get(side);
  };

  const picked = new Map<string, ManualJurisdiction>();
  let zoneMissing = false;
  for (const level of LEVELS) {
    const zone = zoneFor(ctx.decision.levelSource[level]);
    if (zone) {
      for (const id of zone.jurisdictionIds) {
        const j = index.byId.get(id);
        if (j && j.agencyId === agencyId && j.level === level) picked.set(j.id, j);
      }
    } else {
      zoneMissing = true;
      if (level === 'state') {
        for (const j of all) if (j.level === 'state') picked.set(j.id, j);
      }
    }
  }

  const needsZones = zones.length > 0 || all.some((j) => j.level !== 'state');
  const jurisdictions: PlannedJurisdiction[] = [];
  for (const j of picked.values()) {
    const rate = rateAt(j, ctx.date);
    if (rate !== null) jurisdictions.push({ jurisdiction: j, rate });
  }
  jurisdictions.sort((a, b) => LEVEL_RANK[a.jurisdiction.level] - LEVEL_RANK[b.jurisdiction.level]);
  return { jurisdictions, zoneMissing: zoneMissing && needsZones };
}

/** A rule's override replaces the agency's combined rate; the jurisdictions keep their shares of it. */
function effectiveRates(agency: AgencyPlan, override: number | null | undefined): number[] {
  const rates = agency.jurisdictions.map((j) => j.rate);
  if (override === null || override === undefined) return rates;
  const total = rates.reduce((a, b) => a + b, 0);
  if (total <= 0) return rates.map((_, i) => (i === 0 ? snap6(override) : 0));
  return rates.map((r) => snap6((r * override) / total));
}

interface AgencyLine {
  plan: AgencyPlan;
  /** Share of the price that is taxable, 0..1. */
  share: number;
  rates: number[];
  taxableCents: number;
  exemptCents: number;
  nonTaxableCents: number;
}

interface LineWork {
  line: SalesTaxRequestLine;
  grossCents: number;
  /** Tax decided up front (tax-inclusive price, user override), outside the rounding groups. */
  fixedTaxCents?: number;
  agencies: AgencyLine[];
  exemptReason?: ExemptReason;
  certificateId?: string;
}

function calculate(index: DataIndex, req: SalesTaxRequest, now: () => Date): SalesTaxResult {
  const engine = 'manual';
  const calculatedAt = now().toISOString();
  const direction = req.direction ?? 'sales';
  const date = isoDay(req.documentDate);

  const decision = decideSourcing({ shipFrom: req.shipFrom, shipTo: req.shipTo, direction });
  if (!decision) return untaxedResult(engine, req, ['no_ship_to'], calculatedAt);
  const state = decision.taxingState;

  if (req.marketplaceFacilitated) {
    return untaxedResult(engine, req, ['marketplace_facilitated'], calculatedAt, state);
  }
  if (!isUsCountry(req.shipTo)) return untaxedResult(engine, req, [], calculatedAt);

  const ctx: Context = { req, date, decision, warnings: new Set() };

  // Which agencies tax this sale.
  const registered = activeRegistrations(req.registrations, state, date);
  const registeredIds = new Set(registered.map((r) => r.agencyId));
  let agencyIds: string[];
  if (direction === 'use') {
    const inState = new Set<string>();
    for (const j of index.byId.values()) if (j.stateCode.toUpperCase() === state) inState.add(j.agencyId);
    agencyIds = [...inState];
    if (registered.length === 0) ctx.warnings.add('no_use_tax_registration');
    if (agencyIds.length === 0) {
      ctx.warnings.add('rates_not_configured');
      return buildResult(engine, req, {
        sourcing: 'none',
        lines: req.lines.map(untaxedLine),
        warnings: ctx.warnings,
        shipToState: state,
        calculatedAt,
      });
    }
  } else {
    if (registered.length === 0) {
      return untaxedResult(
        engine,
        req,
        stateHasNoSalesTax(state) ? [] : ['not_registered_in_state'],
        calculatedAt,
        state,
      );
    }
    agencyIds = registered.map((r) => r.agencyId);
  }
  agencyIds = orderAgencies(agencyIds, req.registrations);

  const plans: AgencyPlan[] = [];
  let zoneMissing = false;
  for (const agencyId of agencyIds) {
    const planned = planAgency(index, agencyId, ctx);
    zoneMissing = zoneMissing || planned.zoneMissing;
    if (planned.jurisdictions.length === 0) continue;
    plans.push({
      agencyId,
      reportAgencyId: direction === 'use' && !registeredIds.has(agencyId) ? undefined : agencyId,
      jurisdictions: planned.jurisdictions,
      rules: index.rulesByAgency.get(agencyId) ?? [],
    });
  }
  if (zoneMissing) {
    ctx.warnings.add('zone_not_found');
    ctx.warnings.add('address_unverified');
  }
  if (plans.length === 0) {
    ctx.warnings.add('rates_not_configured');
    return buildResult(engine, req, {
      sourcing: decision.sourcing,
      lines: req.lines.map(untaxedLine),
      warnings: ctx.warnings,
      shipToState: state,
      calculatedAt,
    });
  }

  // Exemption certificate: sales only.
  let certificate: { reason: ExemptReason; id: string } | undefined;
  if (direction === 'sales') {
    const found = certificateForSale(req, state, date);
    if (found.certificate) certificate = { reason: found.certificate.reason, id: found.certificate.id };
    if (found.warning) ctx.warnings.add(found.warning);
  }

  const work = req.lines.map((line) => workLine(line, plans, req, date, certificate));

  // Rounding groups: every line that has no fixed tax.
  const rounding = roundingFor(state);
  const cells: TaxCell[] = [];
  const cellRefs: Array<{ line: number; agency: number; jurisdiction: number }> = [];
  work.forEach((w, li) => {
    if (w.fixedTaxCents !== undefined) return;
    w.agencies.forEach((a, ai) => {
      a.plan.jurisdictions.forEach((j, ji) => {
        cells.push({
          lineId: w.line.lineId,
          jurisdictionKey: j.jurisdiction.id,
          unrounded: exactTax(a.taxableCents, a.rates[ji]),
        });
        cellRefs.push({ line: li, agency: ai, jurisdiction: ji });
      });
    });
  });
  const rounded = roundTaxCells(cells, rounding);
  const taxCents = new Map<string, number>();
  cellRefs.forEach((ref, k) => taxCents.set(`${ref.line}:${ref.agency}:${ref.jurisdiction}`, rounded[k]));

  const lines: SalesTaxLineResult[] = work.map((w, li) => {
    // Cents per (agency, jurisdiction) in detail order.
    const flat: Array<{ a: AgencyLine; ai: number; ji: number }> = [];
    w.agencies.forEach((a, ai) => a.plan.jurisdictions.forEach((_, ji) => flat.push({ a, ai, ji })));

    let parts: number[];
    if (w.fixedTaxCents !== undefined) {
      parts = spreadTax(
        w.fixedTaxCents,
        flat.map((f) => exactTax(f.a.taxableCents, f.a.rates[f.ji])),
        flat.map((f) => f.a.rates[f.ji]),
      );
    } else {
      parts = flat.map((f) => taxCents.get(`${li}:${f.ai}:${f.ji}`) ?? 0);
    }

    const details: SalesTaxDetail[] = flat.map((f, k) => {
      const j = f.a.plan.jurisdictions[f.ji].jurisdiction;
      const exempt = f.a.exemptCents > 0;
      const unrounded = exactTax(f.a.taxableCents, f.a.rates[f.ji]);
      return {
        jurisdictionCode: j.code ?? j.id,
        jurisdictionName: j.name,
        level: j.level,
        stateCode: j.stateCode.toUpperCase(),
        ...(f.a.plan.reportAgencyId ? { agencyId: f.a.plan.reportAgencyId } : {}),
        ...(j.reportingCode ? { reportingCode: j.reportingCode } : {}),
        rate: f.a.rates[f.ji],
        taxableAmount: fromCents(f.a.taxableCents),
        exemptAmount: fromCents(f.a.exemptCents),
        nonTaxableAmount: fromCents(f.a.nonTaxableCents),
        tax: fromCents(parts[k]),
        unroundedTax: w.fixedTaxCents !== undefined ? snap6(fromCents(parts[k])) : snap6(unrounded),
        ...(exempt && w.exemptReason ? { exemptReason: w.exemptReason } : {}),
        ...(exempt && w.certificateId ? { certificateId: w.certificateId } : {}),
      };
    });

    const primary = w.agencies[0];
    return {
      lineId: w.line.lineId,
      grossAmount: fromCents(w.grossCents),
      taxableAmount: fromCents(primary.taxableCents),
      exemptAmount: fromCents(primary.exemptCents),
      nonTaxableAmount: fromCents(primary.nonTaxableCents),
      tax: fromCents(parts.reduce((s, p) => s + p, 0)),
      ...(w.line.override ? { overridden: true, overrideReason: w.line.override.reason } : {}),
      details,
    };
  });

  return buildResult(engine, req, {
    sourcing: decision.sourcing,
    lines,
    warnings: ctx.warnings,
    shipToState: state,
    calculatedAt,
  });
}

/** State-level registrations first, so the line summary reads the state agency. */
function orderAgencies(agencyIds: string[], registrations: SalesTaxRegistration[]): string[] {
  const level = new Map(registrations.map((r) => [r.agencyId, r.level]));
  return [...new Set(agencyIds)].sort((a, b) => {
    const la = level.get(a) === 'local' ? 1 : 0;
    const lb = level.get(b) === 'local' ? 1 : 0;
    return la - lb;
  });
}

/** Tax before rounding, at full precision; reported through `snap6`. */
function exactTax(taxableCents: number, ratePercent: number): number {
  return (fromCents(taxableCents) * ratePercent) / 100;
}

function workLine(
  line: SalesTaxRequestLine,
  plans: AgencyPlan[],
  req: SalesTaxRequest,
  date: string,
  certificate: { reason: ExemptReason; id: string } | undefined,
): LineWork {
  const use: TaxUse = line.use ?? req.customer.use ?? 'business';
  const neverTaxed = line.taxCode === 'non_taxable';
  const amountCents = toCents(line.amount);
  const overrideCents = line.override ? toCents(line.override.amount) : 0;

  const prelim = plans.map((plan) => {
    const rule = neverTaxed ? undefined : ruleAt(plan.rules, line.taxCode, use, date);
    const share = neverTaxed ? 0 : rule ? (rule.taxable ? clampPercent(rule.taxablePercent) / 100 : 0) : 1;
    const rates = effectiveRates(plan, rule?.taxable ? rule.rateOverride : null);
    return { plan, share, rates };
  });

  // A tax-inclusive price holds the tax: back it out so net + tax = the price.
  let grossCents = amountCents;
  let fixedTaxCents: number | undefined;
  if (line.taxIncluded) {
    if (line.override) {
      grossCents = amountCents - overrideCents;
    } else {
      const factor = certificate
        ? 0
        : prelim.reduce((sum, p) => sum + p.share * p.rates.reduce((a, b) => a + b, 0), 0) / 100;
      grossCents = toCents(fromCents(amountCents) / (1 + factor));
    }
    fixedTaxCents = amountCents - grossCents;
  } else if (line.override) {
    // The user's tax rides on the computed jurisdictions: it replaces their tax, not their bases.
    fixedTaxCents = overrideCents;
  }

  const agencies: AgencyLine[] = prelim.map(({ plan, share, rates }) => {
    const taxablePart = toCents((fromCents(grossCents) * share));
    const exempt = certificate && taxablePart !== 0 ? taxablePart : 0;
    return {
      plan,
      share,
      rates,
      taxableCents: taxablePart - exempt,
      exemptCents: exempt,
      nonTaxableCents: grossCents - taxablePart,
    };
  });

  const exempted = agencies.some((a) => a.exemptCents !== 0);
  return {
    line,
    grossCents,
    ...(fixedTaxCents !== undefined ? { fixedTaxCents } : {}),
    agencies,
    ...(exempted && certificate ? { exemptReason: certificate.reason, certificateId: certificate.id } : {}),
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(0, value));
}

export function createManualEngine(data: ManualEngineData, options: ManualEngineOptions = {}): SalesTaxEngine {
  const index = indexData(data);
  const now = options.now ?? (() => new Date());
  return {
    id: 'manual',
    async calculate(req: SalesTaxRequest): Promise<SalesTaxResult> {
      return calculate(index, req, now);
    },
  };
}

