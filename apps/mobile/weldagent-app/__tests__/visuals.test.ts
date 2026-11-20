import {
  encodeVisualMarker,
  splitReplyParts,
  visualToCsv,
  type ChartVisual,
} from '@weldsuite/app-api-client/schemas/chat-visuals';
import {
  arcPath,
  areaPath,
  linePath,
  linearScale,
  niceStep,
  niceTicks,
  pieSlices,
  seriesColor,
  valueRange,
  VISUAL_PALETTE,
} from '@/lib/visuals';

const chart: ChartVisual = {
  type: 'chart',
  kind: 'bar',
  title: 'Revenue',
  labels: ['Jan', 'Feb', 'Mar'],
  series: [
    { name: 'NL', values: [10, 20, -5] },
    { name: 'BE', values: [5, null, 15] },
  ],
};

describe('niceStep / niceTicks', () => {
  it('picks round steps', () => {
    expect(niceStep(100, 4)).toBe(20);
    expect(niceStep(7, 4)).toBe(2);
    expect(niceStep(0, 4)).toBe(1);
  });

  it('spans the range with round ticks, 0 included', () => {
    expect(niceTicks(0, 87)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-5, 20)).toEqual([-5, 0, 5, 10, 15, 20]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    expect(niceTicks(3, 3)).toEqual([0, 3]);
  });
});

describe('valueRange', () => {
  it('covers every value and 0', () => {
    expect(valueRange(chart)).toEqual([-5, 20]);
  });

  it('adds stacked series up per label', () => {
    expect(valueRange({ ...chart, stacked: true })).toEqual([-5, 20]);
    expect(valueRange({ ...chart, stacked: true, series: [{ name: 'a', values: [1, 2, 3] }, { name: 'b', values: [4, 5, 6] }] })).toEqual([0, 9]);
  });
});

describe('paths', () => {
  it('maps linearly', () => {
    const y = linearScale([0, 100], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(50)).toBe(100);
  });

  it('breaks a line at a gap', () => {
    expect(linePath([{ x: 0, y: 1 }, { x: 10, y: 2 }, null, { x: 30, y: 3 }])).toBe('M0 1L10 2M30 3');
  });

  it('closes an area to its baseline', () => {
    expect(areaPath([{ x: 0, y: 10 }, { x: 10, y: 5 }], 20)).toBe('M0 20L0 10L10 5L10 20L0 20Z');
  });

  it('draws a pie slice and a donut segment', () => {
    expect(arcPath(50, 50, 40, 0, 0, Math.PI / 2)).toBe('M50 50L50 10A40 40 0 0 1 90 50Z');
    expect(arcPath(50, 50, 40, 20, 0, Math.PI / 2)).toBe('M50 10A40 40 0 0 1 90 50L70 50A20 20 0 0 0 50 30Z');
  });

  it('draws a full circle as two halves', () => {
    expect(arcPath(50, 50, 40, 0, 0, Math.PI * 2).match(/A/g)).toHaveLength(2);
  });
});

describe('pieSlices', () => {
  it('skips empty slices and fills the circle', () => {
    const slices = pieSlices({ ...chart, kind: 'pie' }, 'Other');
    expect(slices.map((s) => s.label)).toEqual(['Jan', 'Feb']);
    expect(slices.at(-1)?.endAngle).toBeCloseTo(Math.PI * 2);
  });

  it('adds up the smallest slices as Other', () => {
    const labels = Array.from({ length: 10 }, (_, i) => `L${i}`);
    const slices = pieSlices(
      { ...chart, kind: 'pie', labels, series: [{ name: 'x', values: labels.map((_, i) => i + 1) }] },
      'Other',
      4,
    );
    expect(slices.map((s) => s.label)).toEqual(['L7', 'L8', 'L9', 'Other']);
    expect(slices[3].value).toBe(1 + 2 + 3 + 4 + 5 + 6 + 7);
  });
});

describe('colours', () => {
  it('cycles through the palette', () => {
    expect(seriesColor(0)).toBe(VISUAL_PALETTE[0]);
    expect(seriesColor(VISUAL_PALETTE.length)).toBe(VISUAL_PALETTE[0]);
  });
});

describe('a stored reply', () => {
  it('splits into text and the visual, in order', () => {
    const content = `Here.\n\n${encodeVisualMarker(chart)}\n\nDone.`;
    expect(splitReplyParts(content).parts.map((p) => p.kind)).toEqual(['text', 'visual', 'text']);
  });

  it('shares as CSV with translated headers', () => {
    expect(visualToCsv(chart, { label: 'Maand' }).split('\r\n')[0]).toBe('Maand,NL,BE');
  });
});
