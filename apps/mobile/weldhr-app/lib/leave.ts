/**
 * Leave rules the app applies before asking the server, mirroring hr-api's
 * `services/weldhr/time.ts` so a button only shows when the action can work.
 */

import type { HrLeaveBalance, HrLeaveStatus } from '@weldsuite/app-api-client/domains/weldhr';

interface RequestLike {
  status: HrLeaveStatus;
  startDate: string;
  endDate: string;
}

/** Upcoming and pending first (soonest at the top), then the past, newest first. */
export function sortRequests<T extends RequestLike>(requests: T[], today: string): T[] {
  const isCurrent = (r: T) => r.status === 'pending' || r.endDate >= today;
  const current = requests.filter(isCurrent).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const past = requests.filter((r) => !isCurrent(r)).sort((a, b) => b.startDate.localeCompare(a.startDate));
  return [...current, ...past];
}

/** An employee may cancel a pending request, or approved leave that has not started yet. */
export function canCancelLeave(request: RequestLike, today: string): boolean {
  if (request.status === 'pending') return true;
  return request.status === 'approved' && request.startDate > today;
}

export type AllowanceCheck = { kind: 'ok' } | { kind: 'over'; remaining: number; blocked: boolean };

/** Whether `days` fits in what is left of the leave type's allowance this year. */
export function checkAllowance(balance: HrLeaveBalance | undefined, days: number): AllowanceCheck {
  if (!balance || balance.remaining == null || days <= balance.remaining) return { kind: 'ok' };
  return { kind: 'over', remaining: Math.max(0, balance.remaining), blocked: balance.overAllowance === 'block' };
}
