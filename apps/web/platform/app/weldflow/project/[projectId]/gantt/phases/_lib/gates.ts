import type { GateCheckItem, GateCriterionInput, GateLinkKind, StoredGateCriterion } from '@weldsuite/app-api-client/domains/project-schedule';
import { fill, shortDate } from '../../dependencies/_lib/format';

type Copy = {
  criteria: Record<string, string>;
  editor: { bands: Record<string, string> };
};

export interface CriterionText {
  title: string;
  detail: string;
}

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' ? value : fallback);

interface DescribeContext {
  item: GateCheckItem;
  facts: GateCheckItem['facts'];
  copy: Copy;
  c: Copy['criteria'];
  locale: string;
  code: string;
}

/** The ", and N more" tail of a criterion detail, only when more than one item matches. */
const moreSuffix = (count: number, template: string): string => (count > 1 ? fill(template, { count: count - 1 }) : '');

function describeTasksDone({ c, facts, code }: DescribeContext): CriterionText {
  const total = num(facts.total);
  return {
    title: fill(c.deliverable_tasks_done, { code }),
    detail: total === 0 ? fill(c.deliverable_tasks_done_empty, { code }) : fill(c.deliverable_tasks_done_detail, { done: num(facts.done), total }),
  };
}

function describeAccepted({ c, facts, code }: DescribeContext): CriterionText {
  return { title: fill(c.deliverable_accepted, { code }), detail: fill(c.deliverable_accepted_detail, { status: text(facts.status) }) };
}

function describeOpenRisk({ c, facts, copy }: DescribeContext): CriterionText {
  const band = copy.editor.bands[text(facts.band)] ?? text(facts.band);
  const top = (facts.top ?? null) as { code: string; title: string; score: number } | null;
  const more = moreSuffix(num(facts.count), c.no_open_risk_above_more);
  return {
    title: fill(c.no_open_risk_above, { band: band.toLowerCase() }),
    detail: top ? fill(c.no_open_risk_above_detail, { code: top.code, title: top.title, score: top.score }) + more : '',
  };
}

function describeDecision({ c, facts, code, item, locale }: DescribeContext): CriterionText {
  const due = text(facts.decisionDueAt);
  const dueNote = due && !item.met ? fill(c.decision_due, { date: shortDate(due, locale) }) : '';
  return {
    title: fill(c.decision_decided, { code }),
    detail: fill(c.decision_decided_detail, { status: text(facts.status) }) + dueNote,
  };
}

function describeChangeRequests({ c, facts }: DescribeContext): CriterionText {
  const first = (facts.first ?? null) as { code: string; title: string } | null;
  const more = moreSuffix(num(facts.count), c.no_change_request_pending_more);
  return {
    title: c.no_change_request_pending,
    detail: first ? fill(c.no_change_request_pending_detail, { code: first.code, title: first.title }) + more : '',
  };
}

function describeSpend({ c, facts, locale }: DescribeContext): CriterionText {
  const budget = facts.budget;
  const spent = money(facts.spent, facts.currency, locale);
  return {
    title: c.spend_within_baseline,
    detail:
      typeof budget === 'string'
        ? fill(c.spend_within_baseline_detail, { spent, budget: money(budget, facts.currency, locale), version: num(facts.baselineVersion) })
        : fill(c.spend_within_baseline_none, { spent }),
  };
}

const DESCRIBERS = new Map<string, (ctx: DescribeContext) => CriterionText>([
  ['deliverable_tasks_done', describeTasksDone],
  ['deliverable_accepted', describeAccepted],
  ['no_open_risk_above', describeOpenRisk],
  ['decision_decided', describeDecision],
  ['no_change_request_pending', describeChangeRequests],
  ['spend_within_baseline', describeSpend],
]);

/** What a criterion asks, and what the data says about it now, in words (the API sends facts, not prose). */
export function describeCriterion(item: GateCheckItem, copy: Copy, locale: string): CriterionText {
  const facts = item.facts;
  const c = copy.criteria;
  if (item.kind === 'manual') {
    const metAt = text(facts.metAt);
    return { title: item.text ?? '', detail: item.met && metAt ? fill(c.manualMetAt, { date: shortDate(metAt, locale) }) : c.manualOpen };
  }
  if (facts.missing === true) {
    const id = text(facts.deliverableId, text(facts.decisionId, ''));
    const name = c[String(item.key)] ?? item.key ?? '';
    return { title: name.replace(/\{code\}/g, id), detail: c.missing };
  }
  const describe = DESCRIBERS.get(item.key ?? '');
  if (!describe) return { title: item.key ?? '', detail: '' };
  return describe({ item, facts, copy, c, locale, code: text(facts.code, '?') });
}

/** An amount as the API sends it (a decimal string) in the project currency. */
export function money(value: unknown, currency: unknown, locale: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return text(value);
  const code = typeof currency === 'string' && currency.length === 3 ? currency : null;
  try {
    return new Intl.NumberFormat(locale, code ? { style: 'currency', currency: code, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 }).format(amount);
  } catch {
    return String(amount);
  }
}

/** The page a gate criterion's link leads to, inside the project. */
export function linkHref(projectId: string, kind: GateLinkKind): string {
  const base = `/weldflow/project/${projectId}`;
  switch (kind) {
    case 'tasks':
      return `${base}/tasks`;
    case 'deliverable':
      return `${base}/scope`;
    case 'raid':
      return `${base}/raid`;
    case 'decision':
      return `${base}/governance/decisions`;
    case 'change_requests':
      return `${base}/governance/changes`;
    case 'finance':
      return `${base}/finance`;
  }
}

// ── The editor's criteria ───────────────────────────────────────────────────

export type CriterionKind =
  | 'deliverable_tasks_done'
  | 'deliverable_accepted'
  | 'no_open_risk_above'
  | 'decision_decided'
  | 'no_change_request_pending'
  | 'spend_within_baseline'
  | 'manual';

export const CRITERION_KINDS: readonly CriterionKind[] = [
  'deliverable_tasks_done',
  'deliverable_accepted',
  'no_open_risk_above',
  'decision_decided',
  'no_change_request_pending',
  'spend_within_baseline',
  'manual',
];

export interface CriterionDraft {
  kind: CriterionKind;
  deliverableId: string;
  decisionId: string;
  band: string;
  text: string;
}

export const emptyCriterion = (kind: CriterionKind = 'manual'): CriterionDraft => ({ kind, deliverableId: '', decisionId: '', band: 'critical', text: '' });

/** A stored criterion as an editable draft. */
export function draftOf(criterion: StoredGateCriterion): CriterionDraft {
  if ('manual' in criterion) return { ...emptyCriterion('manual'), text: criterion.manual };
  const params = (criterion.params ?? {}) as Record<string, unknown>;
  return {
    kind: criterion.key as CriterionKind,
    deliverableId: text(params.deliverableId),
    decisionId: text(params.decisionId),
    band: text(params.band, 'critical'),
    text: '',
  };
}

/** Whether the draft has everything its kind needs. */
export function draftComplete(draft: CriterionDraft): boolean {
  switch (draft.kind) {
    case 'manual':
      return draft.text.trim().length > 0;
    case 'deliverable_tasks_done':
    case 'deliverable_accepted':
      return draft.deliverableId !== '';
    case 'decision_decided':
      return draft.decisionId !== '';
    case 'no_open_risk_above':
      return ['low', 'medium', 'high', 'critical'].includes(draft.band);
    default:
      return true;
  }
}

/** The request body form of a draft. */
export function criterionOf(draft: CriterionDraft): GateCriterionInput {
  switch (draft.kind) {
    case 'manual':
      return { manual: draft.text.trim() };
    case 'deliverable_tasks_done':
    case 'deliverable_accepted':
      return { key: draft.kind, params: { deliverableId: draft.deliverableId } };
    case 'decision_decided':
      return { key: draft.kind, params: { decisionId: draft.decisionId } };
    case 'no_open_risk_above':
      return { key: draft.kind, params: { band: draft.band } };
    default:
      return { key: draft.kind };
  }
}

/** Whether editing changed the criteria (a manual criterion's tick is kept while its text is). */
export function criteriaChanged(original: readonly StoredGateCriterion[], drafts: readonly CriterionDraft[]): boolean {
  if (original.length !== drafts.length) return true;
  return original.some((criterion, index) => JSON.stringify(criterionOf(draftOf(criterion))) !== JSON.stringify(criterionOf(drafts[index])));
}

/** A move of one entry by `delta` places; out of range leaves the list as it is. */
export function moveItem<T>(items: readonly T[], from: number, delta: number): T[] {
  const to = from + delta;
  if (to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
