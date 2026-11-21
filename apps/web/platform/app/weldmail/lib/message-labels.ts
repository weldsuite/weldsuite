/**
 * Case-insensitive helpers for a message's `labels` array.
 *
 * System labels are stored upper-case (`SPAM`, `INBOX`, `IMPORTANT`), but older
 * code and some payloads carry the lower-case slug (`spam`). Comparing with
 * `includes('spam')` therefore missed the stored `SPAM`, which is how "Not
 * spam" ended up marking a mail as spam again (TASK-937). Always go through
 * these helpers when looking for a system label.
 */

type Labels = readonly string[] | null | undefined;

/** True when `labels` carries `label`, whatever the casing of either. */
export function hasLabel(labels: Labels, label: string): boolean {
  const wanted = label.toLowerCase();
  return (labels ?? []).some((l) => l.toLowerCase() === wanted);
}

/** `labels` without any casing of `label`. */
export function withoutLabel(labels: Labels, label: string): string[] {
  const unwanted = label.toLowerCase();
  return (labels ?? []).filter((l) => l.toLowerCase() !== unwanted);
}

/** `labels` with `label` added once (it is not repeated when already there). */
export function withLabel(labels: Labels, label: string): string[] {
  return hasLabel(labels, label) ? [...(labels ?? [])] : [...(labels ?? []), label];
}

// Labels that hold the mail's state (its folder, star, pin, …). The UI shows
// them as folders and icons, never as label chips.
const STATE_LABELS = new Set([
  'inbox',
  'sent',
  'draft',
  'drafts',
  'trash',
  'spam',
  'starred',
  'important',
  'archive',
  'snoozed',
  'scheduled',
  'promotions',
  'pinned',
  'muted',
  'unread',
  'all',
]);

/** The labels a person put on the mail: `labels` without the system ones. */
export function userLabelsOf(labels: Labels): string[] {
  return (labels ?? []).filter((l) => !STATE_LABELS.has(l.toLowerCase()));
}
