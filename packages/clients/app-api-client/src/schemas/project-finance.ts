// Shared Zod schemas for WeldFlow project cost, forecast and earned value
// (`/api/project-finance`; design: weldflow-delivery-and-portfolio.md "Finance
// and earned value", ADR FLOW-019). Amounts are decimal strings with two
// decimals in the project's `budget_currency`; a caller without finance rights
// gets null amounts and the percentages only.

import { z } from 'zod';

/** Where a cost line comes from. */
export const COST_SOURCES = ['time', 'bill', 'journal', 'purchase_order', 'declaration'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export const FORECAST_SOURCES = ['manual', 'cpi', 'budget'] as const;
export type ForecastSource = (typeof FORECAST_SOURCES)[number];

/** The manual forecast the project manager sets, with why. */
export const manualForecastBodySchema = z
  .object({
    /** The forecast at completion; null clears the manual forecast. */
    forecast: z.number().min(0).max(1_000_000_000).nullable(),
    reason: z.string().trim().max(1000).nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.forecast !== null && !value.reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'A reason is required for a manual forecast' });
    }
  });
export type ManualForecastBody = z.infer<typeof manualForecastBodySchema>;

export const costsQuerySchema = z.object({
  source: z.enum(COST_SOURCES).optional(),
  /** `YYYY-MM-DD`, inclusive. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});
export type CostsQuery = z.infer<typeof costsQuerySchema>;

export interface FinancePercentages {
  /** Each as a percentage of the budget, one decimal; null without a budget. */
  spent: number | null;
  committed: number | null;
  planned: number | null;
  earned: number | null;
  forecast: number | null;
}

export interface FinanceFigures {
  budget: string | null;
  actual: string | null;
  committed: string | null;
  plannedValue: string | null;
  earnedValue: string | null;
  forecast: string | null;
  /** Forecast minus budget: positive is over budget. */
  variance: string | null;
  /** Earned value / actual cost, two decimals; null while nothing is spent. */
  cpi: number | null;
  /** Earned value / planned value, two decimals; null while nothing is planned. */
  spi: number | null;
  forecastSource: ForecastSource | null;
}

export interface ManualForecast {
  amount: string | null;
  reason: string | null;
  setBy: string;
  setAt: string;
}

export interface FinanceRow {
  /** The deliverable id; null is the work and costs that belong to no deliverable. */
  id: string | null;
  /** `D3`, null for the unassigned row. */
  code: string | null;
  title: string | null;
  plannedHours: number;
  /** 0 to 100. */
  percentDone: number;
  budget: string | null;
  labour: string | null;
  expenses: string | null;
  purchases: string | null;
  actual: string | null;
  committed: string | null;
  forecast: string | null;
  variance: string | null;
}

export interface ProjectFinance {
  projectId: string;
  /** The project's `budget_currency`; null when it has none (no line is excluded then). */
  currency: string | null;
  /** False: the caller sees percentages only. */
  canSeeAmounts: boolean;
  asOf: string;
  baseline: { id: string; version: number; createdAt: string } | null;
  figures: FinanceFigures;
  percent: FinancePercentages;
  manualForecast: ManualForecast | null;
  /** Actual cost by source. */
  bySource: Record<CostSource, string | null>;
  /** Lines tagged to the project but in another currency, left out of every figure. */
  excludedLines: number;
  rows: FinanceRow[];
}

export interface CostLine {
  /** Unique across sources, e.g. `bill:bli_1`. */
  id: string;
  source: CostSource;
  /** `YYYY-MM-DD`. */
  date: string;
  title: string | null;
  /** Bill number, PO number, entry number or category. */
  reference: string | null;
  status: string | null;
  /** Actual cost of the line. */
  amount: string;
  /** Still to receive (purchase order lines). */
  committed: string;
  /** Time lines are one per ISO week: the hours and people behind it. */
  hours: number | null;
  people: number | null;
}

export interface FinanceSnapshot {
  week: string;
  budget: string | null;
  plannedValue: string | null;
  earnedValue: string | null;
  actualCost: string | null;
  committed: string | null;
  forecast: string | null;
  percent: FinancePercentages;
  createdAt: string;
}

export interface FinanceSettings {
  manualForecast: ManualForecast | null;
  /** Newest first. */
  history: ManualForecast[];
}
