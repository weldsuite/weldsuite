/**
 * What the governance and scope pages share: what the signed-in member may do
 * in the project, and the project's members as names and select options.
 */

import { useCallback, useMemo } from 'react';
import { usePermissions } from '@weldsuite/permissions/react';
import { useI18n } from '@/lib/i18n/provider';
import { useProjectMembers } from '@/hooks/queries/use-projects-queries';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { intlLocaleOf } from '../../raid/_lib/locale';

/** What the member may do: each is the project role and the matching workspace permission. */
export interface GovernanceAbilities {
  create: boolean;
  update: boolean;
  remove: boolean;
  /** The project manager's rights: record a decision, accept or reject a deliverable. */
  manage: boolean;
}

export interface GovernanceMember {
  userId: string;
  name: string;
  avatar: string | null;
}

export function useGovernance(projectId: string) {
  const { canWrite, isAdmin } = useProjectPermissions();
  const { can } = usePermissions();
  const membersQuery = useProjectMembers(projectId);

  const abilities: GovernanceAbilities = {
    create: canWrite && can('projects:create'),
    update: canWrite && can('projects:update'),
    remove: canWrite && can('projects:delete'),
    manage: isAdmin && can('projects:update'),
  };

  const members = useMemo<GovernanceMember[]>(
    () =>
      (membersQuery.data?.data ?? [])
        .filter((member) => member.isActive !== false && !member.leftAt)
        .map((member) => ({
          userId: member.userId,
          name: member.user?.name || member.user?.email || member.userId,
          avatar: member.user?.avatar ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [membersQuery.data],
  );
  const byId = useMemo(() => new Map(members.map((member) => [member.userId, member])), [members]);
  const memberOf = useCallback((userId: string | null | undefined) => (userId ? (byId.get(userId) ?? null) : null), [byId]);
  const options = useMemo(() => members.map((member) => ({ value: member.userId, label: member.name })), [members]);

  return { abilities, members, memberOf, memberOptions: options };
}

/** Dates and numbers in the user's language. */
export function useFormatters() {
  const { language } = useI18n();
  const locale = intlLocaleOf(language);
  return useMemo(
    () => ({
      date: (iso: string | null | undefined): string =>
        iso ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : '',
      shortDate: (iso: string | null | undefined): string =>
        iso ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(iso)) : '',
      month: (period: string): string => {
        const [year, month] = period.split('-').map(Number) as [number, number];
        return new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit' }).format(new Date(Date.UTC(year, month - 1, 1)));
      },
      /** A numeric column's text as a number in the user's language ("1.090"), with its unit. */
      value: (text: string | null | undefined, unit?: string | null): string => {
        if (text === null || text === undefined) return '';
        const number = Number(text);
        if (!Number.isFinite(number)) return text;
        const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(number);
        if (!unit) return formatted;
        return unit === '%' ? `${formatted}%` : `${formatted} ${unit}`;
      },
    }),
    [locale],
  );
}

/** An ISO timestamp as the value of a date input (`2026-11-06`). */
export function toDateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

/** A date input value as the ISO timestamp the API takes, or null. */
export function fromDateInput(value: string | null | undefined): string | null {
  return value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null;
}
