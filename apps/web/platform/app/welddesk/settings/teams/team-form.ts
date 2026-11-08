/**
 * The team form: what the editor edits and how it becomes the
 * `/api/helpdesk-departments` payload. Members are Clerk user ids
 * (`agentIds`, what the inbox assigns), the manager is the workspace member
 * id (`managerId` is varchar(30)). Pure, so it can be tested without rendering.
 */

import type {
  DeskEscalationCondition,
  DeskEscalationRule,
  DeskEscalationTarget,
  DeskTeam,
  DeskTeamInput,
  DeskTeamMember,
} from '@/hooks/queries/use-desk-routing-queries';

export const ESCALATION_CONDITIONS: DeskEscalationCondition[] = ['unassigned', 'no_response', 'sla_breach', 'custom'];
export const ESCALATION_TARGETS: DeskEscalationTarget[] = ['manager', 'next_tier', 'specific_agent'];

export interface EscalationRuleValues {
  condition: DeskEscalationCondition;
  afterMinutes: string;
  escalateTo: DeskEscalationTarget;
  escalateToId: string | null;
  notifyCustomer: boolean;
}

export interface TeamFormValues {
  name: string;
  description: string;
  agentIds: string[];
  managerMemberId: string | null;
  isActive: boolean;
  sortOrder: string;
  escalationRules: EscalationRuleValues[];
}

export function newEscalationRule(): EscalationRuleValues {
  return { condition: 'unassigned', afterMinutes: '15', escalateTo: 'manager', escalateToId: null, notifyCustomer: false };
}

export function emptyTeamValues(sortOrder: number): TeamFormValues {
  return { name: '', description: '', agentIds: [], managerMemberId: null, isActive: true, sortOrder: String(sortOrder), escalationRules: [] };
}

/** The manager as the picker knows them: by member id, or by user id (a team saved elsewhere). */
function managerMemberId(team: DeskTeam, members: DeskTeamMember[]): string | null {
  if (!team.managerId) return null;
  const found = members.find((m) => m.memberId === team.managerId || m.userId === team.managerId);
  return found?.memberId ?? team.managerId;
}

export function teamToValues(team: DeskTeam, members: DeskTeamMember[]): TeamFormValues {
  return {
    name: team.name,
    description: team.description ?? '',
    agentIds: team.agentIds,
    managerMemberId: managerMemberId(team, members),
    isActive: team.isActive,
    sortOrder: String(team.sortOrder),
    escalationRules: team.escalationRules.map((rule) => ({
      condition: rule.condition,
      afterMinutes: String(rule.afterMinutes),
      escalateTo: rule.escalateTo,
      escalateToId: rule.escalateToId ?? null,
      notifyCustomer: rule.notifyCustomer === true,
    })),
  };
}

export type TeamFormError =
  | { field: 'name' }
  | { field: 'sortOrder' }
  | { field: 'afterMinutes'; index: number }
  | { field: 'escalateToId'; index: number };

const WHOLE = /^\d+$/;
const SIGNED_WHOLE = /^-?\d+$/;

export function validateTeamValues(values: TeamFormValues): TeamFormError | null {
  if (!values.name.trim()) return { field: 'name' };
  if (!SIGNED_WHOLE.test(values.sortOrder.trim())) return { field: 'sortOrder' };
  for (const [index, rule] of values.escalationRules.entries()) {
    const after = rule.afterMinutes.trim();
    if (!WHOLE.test(after) || Number(after) > 525_600) return { field: 'afterMinutes', index };
    if (rule.escalateTo === 'specific_agent' && !rule.escalateToId) return { field: 'escalateToId', index };
  }
  return null;
}

export function valuesToTeamInput(
  values: TeamFormValues,
  members: DeskTeamMember[],
  current?: Pick<DeskTeam, 'managerId' | 'managerName'> | null,
): DeskTeamInput {
  const manager = members.find((m) => m.memberId === values.managerMemberId);
  // An unchanged manager the member list doesn't have (still loading, or the
  // member left) keeps the stored name instead of losing it.
  const unchanged = Boolean(current?.managerId) && values.managerMemberId === current?.managerId;
  const managerName = manager?.name ?? (unchanged ? (current?.managerName ?? null) : null);
  const escalationRules: DeskEscalationRule[] = values.escalationRules.map((rule) => ({
    condition: rule.condition,
    afterMinutes: Number(rule.afterMinutes.trim()),
    escalateTo: rule.escalateTo,
    ...(rule.escalateTo === 'specific_agent' && rule.escalateToId ? { escalateToId: rule.escalateToId } : {}),
    ...(rule.notifyCustomer ? { notifyCustomer: true } : {}),
  }));
  return {
    name: values.name.trim(),
    description: values.description.trim(),
    agentIds: Array.from(new Set(values.agentIds)),
    managerId: values.managerMemberId,
    managerName: values.managerMemberId ? managerName : null,
    isActive: values.isActive,
    sortOrder: Number(values.sortOrder.trim()),
    escalationRules,
  };
}
