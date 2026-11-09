/**
 * What forms-api works out from the responses, for the preview: the table's
 * columns, the per-field summary and the insights. Plain functions over the
 * fixtures, so the mock API and the tests share them.
 */

import { choicesOf, fieldsOf, type ChoiceAnswer, type FieldBlock, type FormDefinition } from '@weldsuite/forms-engine';
import type {
  FormFieldSummary,
  FormInsights,
  FormResponseColumn,
  FormResponseDto,
  FormResultsSummary,
} from '@weldsuite/app-api-client/schemas/weldforms';
import type { FormActivityEvent } from './fixtures';

export interface DateRange {
  from?: string;
  to?: string;
}

const PART_LABELS: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  phone: 'Phone',
  company: 'Company',
  line1: 'Address',
  line2: 'Address 2',
  city: 'City',
  state: 'State',
  postalCode: 'Postal code',
  country: 'Country',
};

function inRange(at: string | null, range: DateRange): boolean {
  if (!at) return false;
  if (range.from && at < range.from) return false;
  if (range.to && at > range.to) return false;
  return true;
}

export function filterByRange(responses: FormResponseDto[], range: DateRange): FormResponseDto[] {
  return responses.filter((r) => inRange(r.submittedAt ?? r.startedAt, range));
}

/** The responses table's columns: the metadata first, then every field (contact and address by part). */
export function buildColumns(definition: FormDefinition, responses: FormResponseDto[]): FormResponseColumn[] {
  const columns: FormResponseColumn[] = [
    { key: 'number', label: '#', type: 'number', versions: [1] },
    { key: 'submittedAt', label: 'Submitted at', type: 'date', versions: [1] },
  ];
  if (responses.some((r) => r.respondentEmail)) columns.push({ key: 'email', label: 'Email', type: 'text', versions: [1] });
  if (responses.some((r) => r.score !== null)) columns.push({ key: 'score', label: 'Score', type: 'score', versions: [1] });

  for (const field of fieldsOf(definition)) {
    if (field.type === 'contact_info' || field.type === 'address') {
      const parts = Object.entries(field.properties.fields as Record<string, { enabled: boolean }>).filter(([, v]) => v.enabled);
      for (const [part] of parts) {
        columns.push({
          key: `${field.id}.${part}`,
          blockId: field.id,
          part,
          label: `${field.title}: ${PART_LABELS[part] ?? part}`,
          type: field.type,
          versions: [1],
        });
      }
    } else {
      columns.push({ key: field.id, blockId: field.id, label: field.title, type: field.type, versions: [1] });
    }
  }
  columns.push({ key: 'duration', label: 'Time taken', type: 'duration', versions: [1] }, { key: 'source', label: 'Source', type: 'text', versions: [1] });
  return columns;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;

function latestText(field: FieldBlock, responses: FormResponseDto[], limit = 5) {
  return responses
    .filter((r) => typeof r.answers[field.id] === 'string' && r.answers[field.id] !== '')
    .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''))
    .slice(0, limit)
    .map((r) => ({ responseId: r.id, value: r.answers[field.id] as string, submittedAt: r.submittedAt ?? r.startedAt }));
}

function summariseField(field: FieldBlock, responses: FormResponseDto[]): FormFieldSummary | null {
  const base = { blockId: field.id, type: field.type, title: field.title };
  const answers = responses.map((r) => r.answers[field.id]).filter((v) => v !== undefined && v !== null && v !== '');
  const answered = answers.length;

  switch (field.type) {
    case 'multiple_choice':
    case 'dropdown':
    case 'picture_choice': {
      const picks = answers as ChoiceAnswer[];
      const counts = new Map<string, number>();
      for (const a of picks) for (const id of a.choiceIds) counts.set(id, (counts.get(id) ?? 0) + 1);
      const others = responses.filter((r) => (r.answers[field.id] as ChoiceAnswer | undefined)?.other);
      return {
        kind: 'choice',
        ...base,
        answered,
        choices: choicesOf(field).map((c) => ({
          id: c.id,
          label: c.label,
          count: counts.get(c.id) ?? 0,
          percent: answered === 0 ? 0 : round1(((counts.get(c.id) ?? 0) / answered) * 100),
        })),
        other: others.length,
        otherLatest: others.slice(0, 5).map((r) => ({
          responseId: r.id,
          value: (r.answers[field.id] as ChoiceAnswer).other ?? '',
          submittedAt: r.submittedAt ?? r.startedAt,
        })),
      };
    }
    case 'nps': {
      const values = answers as number[];
      const promoters = values.filter((v) => v >= 9).length;
      const detractors = values.filter((v) => v <= 6).length;
      return {
        kind: 'nps',
        ...base,
        answered,
        score: answered === 0 ? null : Math.round(((promoters - detractors) / answered) * 100),
        promoters,
        passives: answered - promoters - detractors,
        detractors,
        distribution: Array.from({ length: 11 }, (_, value) => ({ value, count: values.filter((v) => v === value).length })),
      };
    }
    case 'number':
    case 'rating':
    case 'opinion_scale': {
      const values = answers as number[];
      const distinct = [...new Set(values)].sort((a, b) => a - b);
      return {
        kind: 'numeric',
        ...base,
        answered,
        average: answered === 0 ? null : round1(values.reduce((s, v) => s + v, 0) / answered),
        min: answered === 0 ? null : Math.min(...values),
        max: answered === 0 ? null : Math.max(...values),
        distribution: distinct.map((value) => ({ value, count: values.filter((v) => v === value).length })),
      };
    }
    case 'yes_no':
    case 'legal': {
      const values = answers as boolean[];
      return { kind: 'boolean', ...base, answered, yes: values.filter(Boolean).length, no: values.filter((v) => !v).length };
    }
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'website':
    case 'date':
      return { kind: 'text', ...base, answered, latest: latestText(field, responses) };
    default:
      return null;
  }
}

export function buildSummary(definition: FormDefinition, all: FormResponseDto[], range: DateRange & { versionId?: string }): FormResultsSummary {
  const responses = filterByRange(all, range).filter((r) => r.status === 'completed' && (!range.versionId || r.versionId === range.versionId));
  const scores = responses.map((r) => r.score).filter((s): s is number => s !== null);
  return {
    totalResponses: responses.length,
    averageScore: scores.length === 0 ? null : round1(scores.reduce((s, v) => s + v, 0) / scores.length),
    fields: fieldsOf(definition)
      .map((field) => summariseField(field, responses))
      .filter((s): s is FormFieldSummary => s !== null),
  };
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

const dayOf = (at: string) => at.slice(0, 10);

/** The first day of the chart: the range start, else the first event, else today. */
function firstDayOf(range: DateRange, events: FormActivityEvent[], now: Date): string {
  if (range.from) return dayOf(range.from);
  if (events[0]) return dayOf(events[0].at);
  return dayOf(now.toISOString());
}

export function buildInsights(
  definition: FormDefinition,
  responses: FormResponseDto[],
  activity: FormActivityEvent[],
  range: DateRange,
  now: Date,
): FormInsights {
  const events = activity.filter((e) => inRange(e.at, range));
  const starts = events.length;
  const completions = events.filter((e) => e.completed).length;
  const done = filterByRange(responses, range).filter((r) => r.durationMs !== null);

  // Visitors who looked at the form: a bit more than twice the starts.
  const viewsFor = (n: number, date: string) => (n === 0 ? date.charCodeAt(9) % 2 : n * 2 + (date.charCodeAt(9) % 3));

  const firstDay = firstDayOf(range, events, now);
  const lastDay = range.to ? dayOf(range.to) : dayOf(now.toISOString());
  const byDay: FormInsights['byDay'] = [];
  for (let t = Date.parse(`${firstDay}T00:00:00Z`); t <= Date.parse(`${lastDay}T00:00:00Z`) && byDay.length < 400; t += 24 * 60 * 60 * 1000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const dayEvents = events.filter((e) => dayOf(e.at) === date);
    byDay.push({
      date,
      views: viewsFor(dayEvents.length, date),
      starts: dayEvents.length,
      completions: dayEvents.filter((e) => e.completed).length,
    });
  }

  const blocks = definition.blocks.filter((b) => b.type !== 'page_break');
  const dropOff = blocks.map((block) => {
    const reached = events.filter((e) => e.path.includes(block.id)).length;
    const leftHere = events.filter((e) => !e.completed && e.exitBlockId === block.id).length;
    return {
      blockId: block.id,
      title: block.title,
      reached,
      leftHere,
      dropOffRate: reached === 0 ? 0 : Math.round((leftHere / reached) * 1000) / 1000,
    };
  });

  const sources = new Map<string, { starts: number; completions: number }>();
  for (const e of events) {
    const entry = sources.get(e.source) ?? { starts: 0, completions: 0 };
    entry.starts += 1;
    if (e.completed) entry.completions += 1;
    sources.set(e.source, entry);
  }

  return {
    views: byDay.reduce((sum, d) => sum + d.views, 0),
    starts,
    completions,
    completionRate: starts === 0 ? null : Math.round((completions / starts) * 1000) / 1000,
    averageDurationMs: done.length === 0 ? null : Math.round(done.reduce((s, r) => s + (r.durationMs ?? 0), 0) / done.length),
    byDay,
    dropOff,
    bySource: [...sources.entries()]
      .map(([source, v]) => ({ source, ...v }))
      .sort((a, b) => b.starts - a.starts),
  };
}
