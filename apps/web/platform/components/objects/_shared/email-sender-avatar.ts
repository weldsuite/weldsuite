/**
 * Whose picture goes next to an email's sender, for the Emails tab of a
 * company / person panel and the email panel it opens.
 *
 * In order: the contact photo the mail API attached to the sender, the
 * record's own image when the sender is the record, a workspace member's
 * picture, and the company's image for anyone else writing from its domain.
 * What is left over (no image here) falls back to a logo looked up by the
 * sender's domain, and then to the initial.
 */

import { useMemo } from 'react';
import type { MailAddress } from '@weldsuite/app-api-client/domains/mail-messages';
import { normalizeLogoDomain } from '@weldsuite/app-api-client/schemas/company-logos';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';

export interface SenderAvatarRecord {
  /** The record's primary email. */
  email?: string | null;
  kind: 'company' | 'person';
  /** The record's own image: uploaded avatar or company logo. */
  avatar?: string | null;
}

export interface SenderAvatar {
  avatarUrl?: string;
  /** Workspace members keep their initial when they have no picture, not their company's logo. */
  isMember: boolean;
}

/** Workspace members' pictures by lower-cased email; a member without one maps to `undefined`. */
export function useMemberPictures(): ReadonlyMap<string, string | undefined> {
  const { data } = useWorkspaceMembers(1, 100);
  return useMemo(() => {
    const pictures = new Map<string, string | undefined>();
    for (const member of data?.data ?? []) {
      if (member.email) pictures.set(member.email.toLowerCase(), member.picture ?? undefined);
    }
    return pictures;
  }, [data]);
}

export function resolveSenderAvatar(
  from: MailAddress | null | undefined,
  record: SenderAvatarRecord | undefined,
  memberPictures: ReadonlyMap<string, string | undefined>,
): SenderAvatar {
  const senderKey = from?.email?.toLowerCase();
  const isMember = !!senderKey && memberPictures.has(senderKey);
  if (from?.avatarUrl) return { avatarUrl: from.avatarUrl, isMember };
  if (!senderKey) return { isMember };

  const recordKey = record?.email?.trim().toLowerCase();
  const recordAvatar = record?.avatar || undefined;
  if (recordKey && senderKey === recordKey && recordAvatar) return { avatarUrl: recordAvatar, isMember };

  const picture = memberPictures.get(senderKey);
  if (picture) return { avatarUrl: picture, isMember };

  // Anyone writing from a company's own domain carries that company's image.
  const recordDomain = record?.kind === 'company' ? normalizeLogoDomain(recordKey) : null;
  if (recordDomain && !isMember && normalizeLogoDomain(senderKey) === recordDomain) {
    return { avatarUrl: recordAvatar, isMember };
  }
  return { isMember };
}
