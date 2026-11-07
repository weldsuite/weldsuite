/**
 * The routing rule form: what the editor edits, how a rule becomes the PUT
 * payload (only set lists and actions), and the one-line summary the list
 * shows. Pure, so it can be tested without rendering.
 */

import type { DeskRoutingRule } from '@/hooks/queries/use-desk-routing-queries';

export const ROUTING_CHANNELS = ['messenger', 'email', 'phone', 'whatsapp', 'sms', 'api', 'portal'] as const;
export const ROUTING_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export type RoutingChannel = (typeof ROUTING_CHANNELS)[number];
export type RoutingPriority = (typeof ROUTING_PRIORITIES)[number];

export interface RoutingFormValues {
  name: string;
  enabled: boolean;
  channels: RoutingChannel[];
  ticketTypeIds: string[];
  tags: string[];
  priorities: RoutingPriority[];
  departmentIds: string[];
  departmentId: string | null;
  assigneeId: string | null;
  priority: RoutingPriority | null;
  addTags: string[];
}

export function emptyRoutingValues(): RoutingFormValues {
  return {
    name: '',
    enabled: true,
    channels: [],
    ticketTypeIds: [],
    tags: [],
    priorities: [],
    departmentIds: [],
    departmentId: null,
    assigneeId: null,
    priority: null,
    addTags: [],
  };
}

export function ruleToValues(rule: DeskRoutingRule): RoutingFormValues {
  const c = rule.conditions ?? {};
  const a = rule.actions ?? {};
  return {
    name: rule.name,
    enabled: rule.enabled,
    channels: (c.channels ?? []) as RoutingChannel[],
    ticketTypeIds: c.ticketTypeIds ?? [],
    tags: c.tags ?? [],
    priorities: (c.priorities ?? []) as RoutingPriority[],
    departmentIds: c.departmentIds ?? [],
    departmentId: a.departmentId ?? null,
    assigneeId: a.assigneeId ?? null,
    priority: (a.priority as RoutingPriority | null | undefined) ?? null,
    addTags: a.addTags ?? [],
  };
}

/** A new rule's id: unique among the workspace's rules, short enough for the schema (64). */
export function newRuleId(existing: Array<{ id: string }>): string {
  const taken = new Set(existing.map((r) => r.id));
  for (;;) {
    const id = `rule_${Math.random().toString(36).slice(2, 10)}`;
    if (!taken.has(id)) return id;
  }
}

/** Trim, drop empties and case-insensitive repeats, at most 50 characters each. */
export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.replaceAll(/\s+/g, ' ').trim().slice(0, 50);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/** The rule as the route takes it: only the lists and actions that are set. */
export function valuesToRule(id: string, values: RoutingFormValues): DeskRoutingRule {
  const conditions: DeskRoutingRule['conditions'] = {};
  if (values.channels.length) conditions.channels = values.channels;
  if (values.ticketTypeIds.length) conditions.ticketTypeIds = values.ticketTypeIds;
  const tags = cleanTags(values.tags);
  if (tags.length) conditions.tags = tags;
  if (values.priorities.length) conditions.priorities = values.priorities;
  if (values.departmentIds.length) conditions.departmentIds = values.departmentIds;
  const actions: DeskRoutingRule['actions'] = {};
  if (values.departmentId) actions.departmentId = values.departmentId;
  if (values.assigneeId) actions.assigneeId = values.assigneeId;
  if (values.priority) actions.priority = values.priority;
  const addTags = cleanTags(values.addTags);
  if (addTags.length) actions.addTags = addTags;
  return { id, name: values.name.trim(), enabled: values.enabled, conditions, actions };
}

export type RoutingFormError = 'nameRequired' | 'noAction';

export function validateRoutingValues(values: RoutingFormValues): RoutingFormError | null {
  if (!values.name.trim()) return 'nameRequired';
  const rule = valuesToRule('check', values);
  if (Object.keys(rule.actions).length === 0) return 'noAction';
  return null;
}

/** Move the rule at `index` up (-1) or down (+1); the same list when it can't move. */
export function moveRule<T>(rules: T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (index < 0 || to < 0 || to >= rules.length) return rules;
  const next = [...rules];
  const [rule] = next.splice(index, 1);
  next.splice(to, 0, rule!);
  return next;
}

export interface RoutingSummaryStrings {
  summary: {
    channels: string;
    types: string;
    tags: string;
    priorities: string;
    teams: string;
    toTeam: string;
    toAssignee: string;
    setPriority: string;
    addTags: string;
    or: string;
  };
  list: { matchesAll: string; noActions: string };
}

export interface RoutingNames {
  channel: (id: string) => string;
  priority: (id: string) => string;
  type: (id: string) => string;
  team: (id: string) => string;
  member: (id: string) => string;
}

/** "channel Email or Phone · tagged vip" and "move to Tier 2 · set priority to High". */
export function ruleSummary(
  rule: DeskRoutingRule,
  t: RoutingSummaryStrings,
  names: RoutingNames,
): { when: string; then: string } {
  const c = rule.conditions ?? {};
  const a = rule.actions ?? {};
  const list = (values: string[] | undefined, name: (id: string) => string) =>
    (values ?? []).map(name).join(t.summary.or);
  const when: string[] = [];
  if (c.channels?.length) when.push(t.summary.channels.replace('{values}', list(c.channels, names.channel)));
  if (c.ticketTypeIds?.length) when.push(t.summary.types.replace('{values}', list(c.ticketTypeIds, names.type)));
  if (c.tags?.length) when.push(t.summary.tags.replace('{values}', list(c.tags, (tag) => tag)));
  if (c.priorities?.length) when.push(t.summary.priorities.replace('{values}', list(c.priorities, names.priority)));
  if (c.departmentIds?.length) when.push(t.summary.teams.replace('{values}', list(c.departmentIds, names.team)));
  const then: string[] = [];
  if (a.departmentId) then.push(t.summary.toTeam.replace('{value}', names.team(a.departmentId)));
  if (a.assigneeId) then.push(t.summary.toAssignee.replace('{value}', names.member(a.assigneeId)));
  if (a.priority) then.push(t.summary.setPriority.replace('{value}', names.priority(a.priority)));
  if (a.addTags?.length) then.push(t.summary.addTags.replace('{values}', a.addTags.join(', ')));
  return {
    when: when.length ? when.join(' · ') : t.list.matchesAll,
    then: then.length ? then.join(' · ') : t.list.noActions,
  };
}
