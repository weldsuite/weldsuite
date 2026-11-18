/**
 * Summary tab: turns the API's per-field summary (`kind` decides the shape)
 * into what a card draws, with the percentages and scales worked out, so the
 * card components only lay it out.
 */

import type { FormFieldSummary } from '@weldsuite/app-api-client/schemas/weldforms';

type Field<K extends FormFieldSummary['kind']> = Extract<FormFieldSummary, { kind: K }>;

export interface BarModel {
  id: string;
  label: string;
  count: number;
  /** Share of the answers, 0..100, one decimal. */
  percent: number;
  /** Bar width as a share of the container, 0..100 (the biggest bar fills it). */
  width: number;
}

export interface CardBase {
  blockId: string;
  type: string;
  title: string;
  answered: number;
}

export type SummaryCardModel =
  | (CardBase & { kind: 'choice'; bars: BarModel[]; other: number; otherLatest: Field<'choice'>['otherLatest'] })
  | (CardBase & {
      kind: 'numeric';
      average: number | null;
      min: number | null;
      max: number | null;
      bars: Array<{ value: number; count: number; height: number }>;
    })
  | (CardBase & {
      kind: 'nps';
      /** -100..100 */
      score: number | null;
      /** 0..100 position of the score on the gauge. */
      gauge: number | null;
      segments: Array<{ id: 'detractors' | 'passives' | 'promoters'; count: number; percent: number }>;
      bars: Array<{ value: number; count: number; height: number }>;
    })
  | (CardBase & { kind: 'boolean'; yes: number; no: number; yesPercent: number; noPercent: number })
  | (CardBase & { kind: 'text'; latest: Field<'text'>['latest'] })
  | (CardBase & {
      kind: 'matrix';
      columns: Field<'matrix'>['columns'];
      rows: Array<{
        id: string;
        label: string;
        total: number;
        cells: Array<{ columnId: string; count: number; percent: number; intensity: number }>;
      }>;
    })
  | (CardBase & {
      kind: 'ranking';
      choices: Array<{ id: string; label: string; averageRank: number | null; rank: number | null }>;
    })
  | (CardBase & { kind: 'files'; files: number });

/** `count / total` as a percentage with one decimal; 0 without a total. */
export function percentOf(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

function scale(count: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((count / max) * 1000) / 10;
}

function distributionBars(distribution: Array<{ value: number; count: number }>) {
  const max = Math.max(0, ...distribution.map((d) => d.count));
  return distribution.map((d) => ({ value: d.value, count: d.count, height: scale(d.count, max) }));
}

export function toSummaryCard(field: FormFieldSummary): SummaryCardModel {
  const base: CardBase = { blockId: field.blockId, type: field.type, title: field.title, answered: field.answered };

  switch (field.kind) {
    case 'choice': {
      const max = Math.max(0, ...field.choices.map((c) => c.count));
      return {
        ...base,
        kind: 'choice',
        bars: field.choices.map((c) => ({
          id: c.id,
          label: c.label,
          count: c.count,
          percent: c.percent,
          width: scale(c.count, max),
        })),
        other: field.other,
        otherLatest: field.otherLatest,
      };
    }
    case 'numeric':
      return {
        ...base,
        kind: 'numeric',
        average: field.average,
        min: field.min,
        max: field.max,
        bars: distributionBars(field.distribution),
      };
    case 'nps': {
      const total = field.promoters + field.passives + field.detractors;
      return {
        ...base,
        kind: 'nps',
        score: field.score,
        gauge: field.score === null ? null : Math.min(100, Math.max(0, (field.score + 100) / 2)),
        segments: [
          { id: 'detractors', count: field.detractors, percent: percentOf(field.detractors, total) },
          { id: 'passives', count: field.passives, percent: percentOf(field.passives, total) },
          { id: 'promoters', count: field.promoters, percent: percentOf(field.promoters, total) },
        ],
        bars: distributionBars(field.distribution),
      };
    }
    case 'boolean': {
      const total = field.yes + field.no;
      return {
        ...base,
        kind: 'boolean',
        yes: field.yes,
        no: field.no,
        yesPercent: percentOf(field.yes, total),
        noPercent: percentOf(field.no, total),
      };
    }
    case 'text':
      return { ...base, kind: 'text', latest: field.latest };
    case 'matrix': {
      let max = 0;
      for (const row of field.rows) for (const n of Object.values(row.counts)) max = Math.max(max, n);
      return {
        ...base,
        kind: 'matrix',
        columns: field.columns,
        rows: field.rows.map((row) => {
          const total = field.columns.reduce((sum, col) => sum + (row.counts[col.id] ?? 0), 0);
          return {
            id: row.id,
            label: row.label,
            total,
            cells: field.columns.map((col) => {
              const count = row.counts[col.id] ?? 0;
              return { columnId: col.id, count, percent: percentOf(count, total), intensity: max > 0 ? count / max : 0 };
            }),
          };
        }),
      };
    }
    case 'ranking': {
      // Best (lowest) average rank first; choices nobody ranked go last.
      const sorted = [...field.choices].sort((a, b) => {
        if (a.averageRank === null && b.averageRank === null) return 0;
        if (a.averageRank === null) return 1;
        if (b.averageRank === null) return -1;
        return a.averageRank - b.averageRank;
      });
      return {
        ...base,
        kind: 'ranking',
        choices: sorted.map((c, index) => ({ ...c, rank: c.averageRank === null ? null : index + 1 })),
      };
    }
    case 'files':
      return { ...base, kind: 'files', files: field.files };
  }
}

/** Where an NPS score sits: the conventional bands. */
export function npsTone(score: number | null): 'danger' | 'warning' | 'success' | 'neutral' {
  if (score === null) return 'neutral';
  if (score < 0) return 'danger';
  if (score < 30) return 'warning';
  return 'success';
}

/** Open-text fields the AI summary can run on (the ones whose card lists text answers). */
export function isAiSummarisable(field: Pick<FormFieldSummary, 'kind'>): boolean {
  return field.kind === 'text';
}
