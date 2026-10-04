/** A vault's trail — who did what, reveals included. Managers only. */

import { useMemo } from 'react';
import {
  useWeldPassTeammates,
  useWeldPassVaultActivity,
  useWeldPassVaultMembers,
} from '@/hooks/queries/use-weldpass-passwords-queries';
import { ErrorBanner, InlineSpinner, TimeAgo, errorMessage } from '../../components/shared';
import { usePasswordsT } from '../lib/use-passwords-t';
import { memberLabel } from './vault-members-panel';

const KNOWN_ACTIONS = new Set([
  'vault.created',
  'vault.updated',
  'vault.deleted',
  'member.added',
  'member.role_changed',
  'member.removed',
  'item.created',
  'item.updated',
  'item.deleted',
  'item.restored',
  'item.revealed',
  'item.totp_generated',
  'item.moved_in',
  'item.moved_out',
  'items.imported',
]);

/** Events whose target label is a user id rather than an item title. */
const MEMBER_ACTIONS = new Set(['member.added', 'member.role_changed', 'member.removed']);

export function VaultActivityPanel({ vaultId }: Readonly<{ vaultId: string }>) {
  const tp = usePasswordsT();
  const { data: events, isLoading, error } = useWeldPassVaultActivity(vaultId);
  const { data: members } = useWeldPassVaultMembers(vaultId);
  const { data: teammates } = useWeldPassTeammates();

  // Member events store a user id; show the person's name when it is known.
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const teammate of teammates ?? []) map.set(teammate.userId, memberLabel(teammate));
    for (const member of members ?? []) map.set(member.userId, memberLabel(member));
    return map;
  }, [members, teammates]);

  if (isLoading) return <InlineSpinner />;

  return (
    <div className="space-y-3">
      <ErrorBanner error={error ? errorMessage(error, tp('activity.loadFailed')) : null} />
      <p className="text-xs text-muted-foreground">{tp('activity.description')}</p>

      {events && events.length === 0 && (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {tp('activity.empty')}
        </p>
      )}

      <ul className="max-h-[45vh] divide-y overflow-y-auto rounded-md border">
        {events?.map((event) => {
          const target = MEMBER_ACTIONS.has(event.action)
            ? (names.get(event.targetLabel ?? '') ?? event.targetLabel)
            : event.targetLabel;
          return (
            <li key={event.id} className="px-3 py-2 text-sm">
              <p>
                <span className="font-medium">{event.actorName || event.actorId}</span>{' '}
                {KNOWN_ACTIONS.has(event.action) ? tp(`activity.actions.${event.action}`) : event.action}
                {target && <span className="text-muted-foreground"> · {target}</span>}
              </p>
              <p className="text-xs">
                <TimeAgo value={event.createdAt} />
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
