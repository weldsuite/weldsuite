/**
 * A few readable facts about a stored report spec, for the version history:
 * the period, the events it counts, how many filters and breakdowns. Reads
 * the spec loosely (an old version may not fit today's schema).
 */

export interface SpecSummary {
  range: string | null;
  events: string[];
  filters: number;
  breakdowns: string[];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function rangeOf(spec: Record<string, unknown>, presets: Readonly<Record<string, string>>): string | null {
  const range = spec.dateRange as { preset?: unknown; from?: unknown; to?: unknown } | undefined;
  if (!range) return null;
  const preset = text(range.preset);
  if (preset) return presets[preset] ?? preset;
  const from = text(range.from);
  const to = text(range.to);
  return from && to ? `${from} – ${to}` : null;
}

function eventsOf(spec: Record<string, unknown>): string[] {
  const named = (item: unknown) => {
    const obj = (item ?? {}) as { label?: unknown; event?: unknown };
    return text(obj.label) ?? text(obj.event);
  };
  const lists = [asArray(spec.series), asArray(spec.steps)];
  const fromLists = lists.flatMap((list) => list.map(named)).filter((e): e is string => e !== null);
  const singles = [spec.startEvent, spec.returnEvent, spec.event, spec.anchor, spec.goal].map(text).filter((e): e is string => e !== null);
  return [...fromLists, ...singles];
}

function breakdownsOf(spec: Record<string, unknown>): string[] {
  const all = [...(spec.breakdown ? [spec.breakdown] : []), ...asArray(spec.breakdowns)];
  return all
    .map((b) => {
      const obj = (b ?? {}) as { field?: unknown; key?: unknown; property?: unknown };
      return text(obj.field) ?? text(obj.key) ?? text(obj.property);
    })
    .filter((b): b is string => b !== null);
}

export function specSummary(spec: Record<string, unknown>, presets: Readonly<Record<string, string>>): SpecSummary {
  return {
    range: rangeOf(spec, presets),
    events: eventsOf(spec),
    filters: asArray(spec.filters).length,
    breakdowns: breakdownsOf(spec),
  };
}
