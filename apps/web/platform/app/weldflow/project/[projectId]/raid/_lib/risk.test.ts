import { describe, expect, it } from 'vitest';
import type { RaidAssessment, RaidItem } from '@weldsuite/app-api-client/domains/project-control';
import {
  DEFAULT_REVIEW_INTERVAL_DAYS,
  RISK_BAND_RANGES,
  buildTrendChart,
  dueStatus,
  filterRisksByCell,
  isOverdue,
  matrixCount,
  reviewIntervalDays,
  reviewIntervalLabel,
  riskBand,
  riskCell,
  riskScore,
  riskStats,
  sameCell,
  sortRisks,
  trendLabelIndexes,
  trendOf,
} from './risk';

const NOW = new Date(2026, 9, 29, 10, 0, 0); // 29 Oct 2026, local

function risk(overrides: Partial<RaidItem> = {}): RaidItem {
  const probability = overrides.probability ?? 3;
  const impact = overrides.impact ?? 3;
  const score = probability * impact;
  return {
    id: 'raid_1',
    projectId: 'proj_1',
    kind: 'risk',
    number: 1,
    code: 'RSK-1',
    title: 'A risk',
    description: null,
    status: 'identified',
    category: null,
    ownerId: null,
    dueAt: null,
    closedAt: null,
    customFields: null,
    probability,
    impact,
    score,
    band: riskBand(score),
    residualProbability: null,
    residualImpact: null,
    residualScore: null,
    strategy: null,
    trigger: null,
    costImpact: null,
    scheduleImpactDays: null,
    reviewIntervalDays: null,
    confidence: null,
    ifWrong: null,
    severity: null,
    escalatedAt: null,
    direction: null,
    partyType: null,
    partyProjectId: null,
    partyName: null,
    createdBy: 'user_1',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    deletedAt: null,
    taskProgress: { done: 0, total: 0 },
    ...overrides,
  };
}

describe('score and band', () => {
  it('multiplies probability and impact', () => {
    expect(riskScore(4, 5)).toBe(20);
    expect(riskScore(1, 1)).toBe(1);
  });

  it('puts every attainable score in the band of the design doc', () => {
    const expected: Record<number, string> = {
      1: 'low', 2: 'low', 3: 'low', 4: 'low',
      5: 'medium', 6: 'medium', 8: 'medium', 9: 'medium',
      10: 'high', 12: 'high', 15: 'high', 16: 'high',
      20: 'critical', 25: 'critical',
    };
    for (const [score, band] of Object.entries(expected)) {
      expect(riskBand(Number(score))).toBe(band);
    }
  });

  it('agrees with every probability x impact pair and leaves no score between two bands', () => {
    for (let p = 1; p <= 5; p++) {
      for (let i = 1; i <= 5; i++) {
        const band = riskBand(riskScore(p, i));
        const range = RISK_BAND_RANGES[band];
        expect(p * i).toBeGreaterThanOrEqual(range.min);
        expect(p * i).toBeLessThanOrEqual(range.max);
      }
    }
  });

  it('reviews by the band interval unless the risk sets its own', () => {
    expect(reviewIntervalDays('critical')).toBe(DEFAULT_REVIEW_INTERVAL_DAYS.critical);
    expect(reviewIntervalDays('high', null)).toBe(14);
    expect(reviewIntervalDays('low', 21)).toBe(21);
  });

  it('words the common review intervals', () => {
    expect(reviewIntervalLabel(7)).toEqual({ unit: 'week' });
    expect(reviewIntervalLabel(14)).toEqual({ unit: 'twoWeeks' });
    expect(reviewIntervalLabel(30)).toEqual({ unit: 'month' });
    expect(reviewIntervalLabel(90)).toEqual({ unit: 'quarter' });
    expect(reviewIntervalLabel(10)).toEqual({ unit: 'days', days: 10 });
  });
});

describe('matrix cells', () => {
  it('uses the current rating, or the after-mitigation one', () => {
    const r = risk({ probability: 4, impact: 5, residualProbability: 2, residualImpact: 4 });
    expect(riskCell(r, false)).toEqual({ probability: 4, impact: 5 });
    expect(riskCell(r, true)).toEqual({ probability: 2, impact: 4 });
  });

  it('keeps a risk without an after-mitigation rating in its current cell', () => {
    const r = risk({ probability: 3, impact: 3 });
    expect(riskCell(r, true)).toEqual({ probability: 3, impact: 3 });
  });

  it('compares cells', () => {
    expect(sameCell({ probability: 1, impact: 2 }, { probability: 1, impact: 2 })).toBe(true);
    expect(sameCell({ probability: 1, impact: 2 }, { probability: 2, impact: 1 })).toBe(false);
    expect(sameCell(null, { probability: 1, impact: 2 })).toBe(false);
  });

  it('filters the register by the selected cell, in either view', () => {
    const a = risk({ id: 'a', probability: 4, impact: 5, residualProbability: 2, residualImpact: 4 });
    const b = risk({ id: 'b', probability: 2, impact: 4 });
    const c = risk({ id: 'c', probability: 1, impact: 1 });
    const all = [a, b, c];
    expect(filterRisksByCell(all, null, false)).toHaveLength(3);
    expect(filterRisksByCell(all, { probability: 4, impact: 5 }, false).map((r) => r.id)).toEqual(['a']);
    // After mitigation: a moved to 2 x 4, where b already is.
    expect(filterRisksByCell(all, { probability: 2, impact: 4 }, true).map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterRisksByCell(all, { probability: 4, impact: 5 }, true)).toEqual([]);
  });

  it('reads a cell count from the matrix', () => {
    const matrix = { residual: false, total: 3, cells: [{ probability: 4, impact: 5, count: 3 }] };
    expect(matrixCount(matrix, { probability: 4, impact: 5 })).toBe(3);
    expect(matrixCount(matrix, { probability: 1, impact: 1 })).toBe(0);
    expect(matrixCount(undefined, { probability: 1, impact: 1 })).toBe(0);
  });
});

describe('sortRisks', () => {
  it('puts the highest score first, then the earliest review, then the oldest number', () => {
    const sorted = sortRisks([
      risk({ id: 'low', number: 1, probability: 1, impact: 2 }),
      risk({ id: 'late-review', number: 2, probability: 4, impact: 4, dueAt: '2026-11-20T10:00:00.000Z' }),
      risk({ id: 'early-review', number: 3, probability: 4, impact: 4, dueAt: '2026-11-02T10:00:00.000Z' }),
      risk({ id: 'no-review', number: 4, probability: 4, impact: 4 }),
      risk({ id: 'top', number: 5, probability: 5, impact: 5 }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['top', 'early-review', 'late-review', 'no-review', 'low']);
  });

  it('does not change the list it is given', () => {
    const input = [risk({ id: 'a', probability: 1, impact: 1 }), risk({ id: 'b', probability: 5, impact: 5 })];
    sortRisks(input);
    expect(input.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('due dates', () => {
  it('counts calendar days from today', () => {
    expect(dueStatus(null, NOW)).toEqual({ kind: 'none' });
    expect(dueStatus(new Date(2026, 9, 27, 12).toISOString(), NOW)).toEqual({ kind: 'overdue', days: 2 });
    expect(dueStatus(new Date(2026, 9, 29, 23).toISOString(), NOW)).toEqual({ kind: 'today' });
    expect(dueStatus(new Date(2026, 9, 30, 1).toISOString(), NOW)).toEqual({ kind: 'tomorrow' });
    expect(dueStatus(new Date(2026, 10, 3, 12).toISOString(), NOW)).toEqual({ kind: 'in', days: 5 });
  });

  it('is overdue only from the day after', () => {
    expect(isOverdue(new Date(2026, 9, 29, 8).toISOString(), NOW)).toBe(false);
    expect(isOverdue(new Date(2026, 9, 28, 23).toISOString(), NOW)).toBe(true);
    expect(isOverdue(null, NOW)).toBe(false);
  });
});

describe('riskStats', () => {
  it('counts bands, overdue reviews and task progress of the open risks', () => {
    const stats = riskStats(
      [
        risk({ probability: 4, impact: 5, dueAt: new Date(2026, 9, 27, 12).toISOString(), taskProgress: { done: 1, total: 5 } }),
        risk({ probability: 4, impact: 4, taskProgress: { done: 2, total: 3 } }),
        risk({ probability: 2, impact: 3, dueAt: new Date(2026, 10, 3, 12).toISOString() }),
      ],
      NOW,
    );
    expect(stats).toEqual({
      open: 3,
      critical: 1,
      high: 1,
      reviewsOverdue: 1,
      tasksDone: 3,
      tasksTotal: 8,
      tasksPercent: 38,
    });
  });

  it('has no task percentage without linked tasks', () => {
    expect(riskStats([risk()], NOW).tasksPercent).toBeNull();
    expect(riskStats([], NOW)).toMatchObject({ open: 0, tasksPercent: null });
  });
});

describe('score trend', () => {
  function assessment(score: number, day: number): RaidAssessment {
    return {
      id: `rasm_${day}`,
      itemId: 'raid_1',
      projectId: 'proj_1',
      probability: 1,
      impact: 1,
      score,
      band: riskBand(score),
      residualProbability: null,
      residualImpact: null,
      note: null,
      assessedBy: 'user_1',
      assessedAt: new Date(2026, 8, day, 12).toISOString(),
    };
  }
  // Newest first, as the API returns them.
  const history = [assessment(20, 27), assessment(16, 13), assessment(15, 29), assessment(12, 15)];

  it('compares the newest assessment with the one before it', () => {
    expect(trendOf(history)).toBe('up');
    expect(trendOf([assessment(8, 2), assessment(12, 1)])).toBe('down');
    expect(trendOf([assessment(12, 2), assessment(12, 1)])).toBe('flat');
    expect(trendOf([assessment(12, 1)])).toBe('none');
    expect(trendOf([])).toBe('none');
  });

  it('lays the assessments out oldest to newest, higher scores higher up', () => {
    const chart = buildTrendChart(history);
    expect(chart.points.map((p) => p.score)).toEqual([12, 15, 16, 20]);
    for (let i = 1; i < chart.points.length; i++) {
      expect(chart.points[i].x).toBeGreaterThan(chart.points[i - 1].x);
      expect(chart.points[i].y).toBeLessThan(chart.points[i - 1].y);
    }
    expect(chart.polyline.split(' ')).toHaveLength(4);
  });

  it('keeps only the last assessments', () => {
    const many = Array.from({ length: 12 }, (_, i) => assessment(12, 12 - i));
    expect(buildTrendChart(many).points).toHaveLength(8);
    expect(buildTrendChart(many, 3).points).toHaveLength(3);
  });

  it('centres a single assessment', () => {
    const chart = buildTrendChart([assessment(9, 1)]);
    expect(chart.points).toHaveLength(1);
    expect(chart.points[0].x).toBe((chart.plot.left + chart.plot.right) / 2);
  });

  it('stacks the band stripes from the critical one at the top to the low one at the bottom', () => {
    const { bands, plot } = buildTrendChart([]);
    expect(bands.map((b) => b.band)).toEqual(['low', 'medium', 'high', 'critical']);
    const critical = bands.find((b) => b.band === 'critical');
    const low = bands.find((b) => b.band === 'low');
    expect(critical?.y).toBe(plot.top);
    expect((low?.y ?? 0) + (low?.height ?? 0)).toBeCloseTo(plot.bottom);
  });

  it('labels every point of a short series and the ends and middle of a long one', () => {
    expect(trendLabelIndexes(0)).toEqual([]);
    expect(trendLabelIndexes(3)).toEqual([0, 1, 2]);
    expect(trendLabelIndexes(4)).toEqual([0, 1, 2, 3]);
    expect(trendLabelIndexes(8)).toEqual([0, 3, 7]);
  });
});
