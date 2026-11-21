import { describe, expect, it } from 'vitest';
import { VISUAL_TOOLS, VISUAL_TOOL_IDS, shownVisual } from './visual-tools';
import type { ToolContext } from './tools';

const ctx = {} as ToolContext;
const tool = (name: string) => VISUAL_TOOLS.find((t) => t.name === name)!;

const chart = {
  kind: 'bar',
  title: 'Open tickets per status',
  labels: ['Open', 'Solved'],
  series: [{ name: 'Tickets', values: [3, 9] }],
};

describe('display tools', () => {
  it('are the four show_* tools, needing no permission', () => {
    expect(VISUAL_TOOLS.map((t) => t.name)).toEqual(['show_chart', 'show_stats', 'show_table', 'show_records']);
    expect(VISUAL_TOOL_IDS).toEqual(['agent.show_chart', 'agent.show_stats', 'agent.show_table', 'agent.show_records']);
    expect(VISUAL_TOOLS.every((t) => t.requiredPermissions.length === 0)).toBe(true);
  });

  it('say a valid spec is on screen', async () => {
    await expect(tool('show_chart').execute(ctx, chart)).resolves.toMatchObject({ ok: true, shownToUser: true });
    await expect(
      tool('show_stats').execute(ctx, { items: [{ label: 'Revenue', value: 1200 }] }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('tell the model what is wrong with a spec they cannot show', async () => {
    const result = (await tool('show_chart').execute(ctx, { ...chart, series: [{ name: 'Tickets', values: [1] }] })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('series.0.values');
    expect(result.error).toContain('one per label');
    const empty = (await tool('show_table').execute(ctx, {})) as { ok: boolean; error: string };
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain('columns');
  });
});

describe('shownVisual', () => {
  it('is the visual of a successful show_* call', () => {
    expect(shownVisual('show_chart', chart, { ok: true })).toEqual({ type: 'chart', ...chart });
    // Without a result (the call itself), the spec decides.
    expect(shownVisual('show_chart', chart)).toEqual({ type: 'chart', ...chart });
  });

  it('is nothing for other tools, refused calls and bad specs', () => {
    expect(shownVisual('list_tasks', chart, { ok: true })).toBeNull();
    expect(shownVisual('show_chart', chart, { ok: false })).toBeNull();
    expect(shownVisual('show_chart', chart, null)).toBeNull();
    expect(shownVisual('show_chart', { title: 'x' }, { ok: true })).toBeNull();
  });
});
