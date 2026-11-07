/**
 * Small pieces of the decision log shared by the list and the object panel:
 * the status pill, a member's name, a person with an avatar, and the labelled
 * facts and flush sections of the panel body.
 */

import { useCallback, type ReactNode } from 'react';
import type { DecisionStatus } from '@weldsuite/app-api-client/domains/project-governance';
import { ListPill } from '@/app/weldflow/components/list-cells';
import { useI18n } from '@/lib/i18n/provider';
import { PersonAvatar } from '../../../raid/_components/raid-parts';
import { TONE_PILL } from '../../../raid/_lib/styles';
import type { GovernanceMember } from '../../_lib/use-governance';

/** Proposed is blue, decided green, superseded quiet. */
const STATUS_PILL: Readonly<Record<DecisionStatus, string>> = {
  proposed: TONE_PILL.blue,
  decided: TONE_PILL.green,
  superseded: TONE_PILL.neutral,
};

export function DecisionStatusPill({ status }: Readonly<{ status: DecisionStatus }>) {
  const { t } = useI18n();
  return <ListPill className={STATUS_PILL[status]}>{t.flowGovernance.decisions.statuses[status]}</ListPill>;
}

type MemberOf = (userId: string | null | undefined) => GovernanceMember | null;

/** The name of a member by user id: "Unassigned" for none, "Former member" when they have left the project. */
export function useMemberName(memberOf: MemberOf): (userId: string | null | undefined) => string {
  const { t } = useI18n();
  return useCallback(
    (userId) => {
      if (!userId) return t.flowGovernance.common.unassigned;
      return memberOf(userId)?.name ?? t.flowGovernance.decisions.unknownMember;
    },
    [memberOf, t],
  );
}

/** A member as avatar and name, for the facts of the panel. */
export function PersonValue({ userId, memberOf }: Readonly<{ userId: string | null | undefined; memberOf: MemberOf }>) {
  const memberName = useMemberName(memberOf);
  if (!userId) return <span className="text-muted-foreground">{memberName(userId)}</span>;
  const member = memberOf(userId);
  const name = memberName(userId);
  return (
    <span className="inline-flex max-w-full items-center gap-2">
      <PersonAvatar name={name} avatar={member?.avatar} className="size-5" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** One labelled fact of the panel's `<dl>`. */
export function Property({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

/** A section of the panel body: flush, under a divider. */
export function PanelSection({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section className="border-b border-border px-6 py-4 last:border-b-0">
      <h3 className="mb-2 text-[13px] font-semibold text-foreground/80">{title}</h3>
      {children}
    </section>
  );
}
