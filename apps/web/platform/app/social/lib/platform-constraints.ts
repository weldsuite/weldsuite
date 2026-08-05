/**
 * Per-platform posting constraints the composer has to enforce BEFORE
 * submitting, because the upstream provider only rejects them afterwards.
 *
 * PostPeer validates these on its side and returns a plain 500 to us, e.g.
 * `instagram: Instagram posts require at least one image or video. Text-only
 * posts are not supported.` By that point the `socialPosts` row exists, the
 * publish slot has been claimed and credits have been charged (then refunded),
 * so the user pays a full round trip to learn something we could have told them
 * while they were still typing.
 */

/**
 * Platforms that reject text-only posts.
 *
 * Instagram is media-first: every post is a feed image, carousel, or reel, so
 * there is no text-only object to create. This is a platform rule rather than a
 * PostPeer one, so it holds regardless of which provider we publish through.
 */
export const PLATFORMS_REQUIRING_MEDIA = ['instagram'] as const;

export function platformRequiresMedia(platform: string): boolean {
  return (PLATFORMS_REQUIRING_MEDIA as readonly string[]).includes(platform);
}

/** The shape this module needs; kept minimal so callers can pass richer rows. */
export interface ConstrainableAccount {
  id: string;
  platform: string;
}

/**
 * Of the accounts currently selected, return those whose platform cannot accept
 * the post as composed — today, media-requiring platforms with nothing attached.
 *
 * Returns the accounts rather than a boolean so the UI can name the offending
 * channels: a workspace can have several Instagram accounts among many
 * channels, and "remove @acme_studio" is actionable where "Instagram needs
 * media" leaves the user hunting.
 *
 * Empty result means "nothing blocks publishing", which is also the answer when
 * no accounts are selected — the composer gates that case separately.
 */
export function accountsBlockedByMissingMedia<T extends ConstrainableAccount>(
  accounts: readonly T[],
  selectedAccountIds: readonly string[],
  selectedMediaIds: readonly string[],
): T[] {
  if (selectedMediaIds.length > 0) return [];
  const selected = new Set(selectedAccountIds);
  return accounts.filter(
    (account) => selected.has(account.id) && platformRequiresMedia(account.platform),
  );
}
