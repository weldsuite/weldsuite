/**
 * Pure rules shared by the Postgres store and the mailbox object, so both
 * agree on what a label change means, which folders a message belongs to,
 * and how a mail rule's conditions and actions evaluate
 * (docs/plans/weldmail-mailbox-store-design.md §2, §3.2). No I/O, no
 * Cloudflare APIs: this file runs inside the object and inside a worker
 * alike.
 *
 * The label/location vocabulary and `leaveLocation`/`labelsForFlagPatch` were
 * extracted from `../labels` and `../messages`, which now import them back so
 * behaviour is unchanged (task A3 of the design, "no behaviour change").
 */

// ---------------------------------------------------------------------------
// System labels, locations
// ---------------------------------------------------------------------------

export const SYSTEM_LABELS = {
  INBOX: 'INBOX',
  SENT: 'SENT',
  DRAFT: 'DRAFT',
  DRAFTS: 'DRAFTS',
  TRASH: 'TRASH',
  SPAM: 'SPAM',
  STARRED: 'STARRED',
  IMPORTANT: 'IMPORTANT',
  ARCHIVE: 'ARCHIVE',
  SNOOZED: 'SNOOZED',
  SCHEDULED: 'SCHEDULED',
  PROMOTIONS: 'PROMOTIONS',
  PINNED: 'PINNED',
} as const;

export type SystemLabel = (typeof SYSTEM_LABELS)[keyof typeof SYSTEM_LABELS];

const SLUG_TO_SYSTEM_LABEL: Record<string, string> = {
  inbox: 'INBOX',
  sent: 'SENT',
  draft: 'DRAFT',
  drafts: 'DRAFTS',
  trash: 'TRASH',
  spam: 'SPAM',
  starred: 'STARRED',
  important: 'IMPORTANT',
  archive: 'ARCHIVE',
  snoozed: 'SNOOZED',
  scheduled: 'SCHEDULED',
  promotions: 'PROMOTIONS',
  pinned: 'PINNED',
};

export function isSystemLabelSlug(slug: string): boolean {
  return slug.toLowerCase() in SLUG_TO_SYSTEM_LABEL;
}

export function toSystemLabel(slug: string): string | null {
  return SLUG_TO_SYSTEM_LABEL[slug.toLowerCase()] ?? null;
}

/** The value a label is stored as: system slugs upper-cased, user labels as typed. */
export function normalizeLabel(label: string): string {
  return toSystemLabel(label) ?? label;
}

/**
 * Where a message lives. A message sits in at most one of these, so trashing,
 * archiving or marking spam takes it out of the inbox instead of adding a
 * second folder (Gmail-style location labels).
 */
export const LOCATION_LABELS = ['INBOX', 'ARCHIVE', 'TRASH', 'SPAM'] as const;
export type LocationLabel = (typeof LOCATION_LABELS)[number];

export function isLocationLabel(label: string): label is LocationLabel {
  return (LOCATION_LABELS as readonly string[]).includes(label);
}

/**
 * Labels a move to any location clears: the other locations, the promotions
 * tab, and a pending snooze (a snoozed mail that is trashed must not wake up
 * in the inbox).
 */
export const CLEARED_BY_MOVE: readonly string[] = [...LOCATION_LABELS, 'PROMOTIONS', 'SNOOZED'];

/** Mail the mailbox sent or is still writing; a restore never puts it in the inbox. */
export const OUTGOING_LABELS: readonly string[] = ['SENT', 'DRAFT', 'DRAFTS', 'SCHEDULED'];

/**
 * Add labels the way every write path must: system slugs normalised, no
 * duplicates, and a location label replacing the previous location.
 */
export function addLabels(existing: string[] | null, ...labels: string[]): string[] {
  let next = [...new Set(existing ?? [])];
  for (const raw of labels) {
    const label = normalizeLabel(raw);
    if (isLocationLabel(label)) next = next.filter((l) => !CLEARED_BY_MOVE.includes(l));
    if (!next.includes(label)) next.push(label);
  }
  return next;
}

export function removeLabels(existing: string[] | null, ...labels: string[]): string[] {
  const toRemove = new Set(labels.map(normalizeLabel));
  return (existing ?? []).filter((l) => !toRemove.has(l));
}

/** The boolean columns on `mail_messages` that mirror a system label. */
export interface LabelFlags {
  isStarred?: boolean;
  isImportant?: boolean;
  isTrash?: boolean;
  isSpam?: boolean;
}

/**
 * The flag columns to write alongside a label change, for the labels it
 * touched only: starring sets `isStarred`, a move sets `isTrash` / `isSpam` to
 * match the new location. Untouched flags are left alone.
 */
export function flagsForLabelChange(labels: string[], action: 'add' | 'remove'): LabelFlags {
  const flags: LabelFlags = {};
  const on = action === 'add';
  for (const raw of labels) {
    const label = normalizeLabel(raw);
    if (label === SYSTEM_LABELS.STARRED) flags.isStarred = on;
    else if (label === SYSTEM_LABELS.IMPORTANT) flags.isImportant = on;
    else if (on && isLocationLabel(label)) {
      flags.isTrash = label === SYSTEM_LABELS.TRASH;
      flags.isSpam = label === SYSTEM_LABELS.SPAM;
    } else if (label === SYSTEM_LABELS.TRASH) flags.isTrash = false;
    else if (label === SYSTEM_LABELS.SPAM) flags.isSpam = false;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Single-message flag patch (extracted from `../messages`: `updateMessage`'s
// `leaveLocation` / `labelsForFlagPatch` helpers)
// ---------------------------------------------------------------------------

/** Leave a location (`TRASH` / `SPAM`): back to the inbox unless the mail already sits somewhere else. */
export function leaveLocation(labels: string[], location: string): string[] {
  const next = removeLabels(labels, location);
  const elsewhere = [SYSTEM_LABELS.TRASH, SYSTEM_LABELS.SPAM, SYSTEM_LABELS.ARCHIVE].some((l) =>
    next.includes(l),
  );
  return elsewhere ? next : addLabels(next, SYSTEM_LABELS.INBOX);
}

/** The subset of `UpdateMessageInput` that mirrors into labels. */
export interface FlagPatchInput {
  isStarred?: boolean;
  isImportant?: boolean;
  isSpam?: boolean;
  isTrash?: boolean;
}

/**
 * The labels array (and the flags a move implies) that a patch of the boolean
 * flags leads to. Null when the patch sets none of the mirrored flags.
 */
export function labelsForFlagPatch(
  existing: string[] | null,
  data: FlagPatchInput,
): { labels: string[]; isTrash?: boolean; isSpam?: boolean } | null {
  const mirrored = [data.isStarred, data.isImportant, data.isSpam, data.isTrash];
  if (mirrored.every((v) => v === undefined)) return null;

  let labels = [...(existing ?? [])];
  const toggle = (value: boolean | undefined, label: string) => {
    if (value === undefined) return;
    labels = value ? addLabels(labels, label) : removeLabels(labels, label);
  };
  toggle(data.isStarred, SYSTEM_LABELS.STARRED);
  toggle(data.isImportant, SYSTEM_LABELS.IMPORTANT);
  if (data.isSpam === true) labels = addLabels(labels, SYSTEM_LABELS.SPAM);
  else if (data.isSpam === false) labels = leaveLocation(labels, SYSTEM_LABELS.SPAM);
  if (data.isTrash === true) labels = addLabels(labels, SYSTEM_LABELS.TRASH);
  else if (data.isTrash === false) labels = leaveLocation(labels, SYSTEM_LABELS.TRASH);

  const moved = data.isSpam !== undefined || data.isTrash !== undefined;
  return moved
    ? {
        labels,
        isTrash: labels.includes(SYSTEM_LABELS.TRASH),
        isSpam: labels.includes(SYSTEM_LABELS.SPAM),
      }
    : { labels };
}

// ---------------------------------------------------------------------------
// Legacy normalisation (backfill, parity): fold boolean flags into labels
// ---------------------------------------------------------------------------

export interface LegacyMessageFlags {
  labels?: readonly string[] | null;
  isStarred?: boolean | null;
  isImportant?: boolean | null;
  isTrash?: boolean | null;
  isSpam?: boolean | null;
}

/** Location labels, in the precedence backfill and parity use when more than one applies to a drifted row. */
const LOCATION_PRECEDENCE: readonly LocationLabel[] = ['TRASH', 'SPAM', 'ARCHIVE', 'INBOX'];

/**
 * The canonical label set for a Postgres row: `isStarred` / `isImportant` /
 * `isTrash` / `isSpam` folded into labels the way the object always stores
 * them, with at most one location label (TRASH > SPAM > ARCHIVE > INBOX when
 * more than one is present — a drifted row, from before the single-location
 * rule). Used by backfill (`applyPgRow`) and by full parity to compare the
 * two stores on the same terms (design §2.2, §4).
 */
export function normalizeLegacy(input: LegacyMessageFlags): string[] {
  const set = new Set(input.labels ?? []);
  if (input.isStarred) set.add(SYSTEM_LABELS.STARRED);
  if (input.isImportant) set.add(SYSTEM_LABELS.IMPORTANT);
  if (input.isTrash) set.add(SYSTEM_LABELS.TRASH);
  if (input.isSpam) set.add(SYSTEM_LABELS.SPAM);

  const present = LOCATION_PRECEDENCE.filter((l) => set.has(l));
  for (const loser of present.slice(1)) set.delete(loser);

  return [...set];
}

// ---------------------------------------------------------------------------
// Folder membership (object derived tables: `message_labels`, `thread_labels`,
// `label_counts` — design §3.2)
// ---------------------------------------------------------------------------

export type FolderKey = string;

export interface FolderKeyInput {
  /** Any truthy value (a `Date`, an ISO string, a SQLite integer) means deleted. */
  deletedAt?: unknown;
  labels: readonly string[] | null | undefined;
  isTrash?: boolean | null;
  isSpam?: boolean | null;
  sendStatus?: string | null;
}

/** Trash or spam, by label or by the mirrored flag — same rule as Postgres's `inTrashOrSpamCondition`. */
export function isInTrashOrSpam(input: Pick<FolderKeyInput, 'labels' | 'isTrash' | 'isSpam'>): boolean {
  const labels = input.labels ?? [];
  return (
    labels.includes(SYSTEM_LABELS.TRASH) ||
    labels.includes(SYSTEM_LABELS.SPAM) ||
    Boolean(input.isTrash) ||
    Boolean(input.isSpam)
  );
}

function isArchived(labels: readonly string[]): boolean {
  return labels.includes(SYSTEM_LABELS.ARCHIVE);
}

const SYSTEM_LABEL_VALUES: ReadonlySet<string> = new Set(Object.values(SYSTEM_LABELS));

/**
 * Every folder key a live message belongs to: `__total` (always, unless
 * deleted), `__all` (unless trashed or spammed), one key per label it
 * carries (lower-cased), and `__scheduled` when it is a live scheduled send.
 * A deleted message belongs to nothing.
 *
 * Mirrors three Postgres predicates at once — `inTrashOrSpamCondition`,
 * `labelFolderHidesArchived` and `labelCondition` from `../labels`, and the
 * stats filters in `../messages`'s `getMessageStats` — so the object and
 * Postgres keep agreeing on what counts as a folder (design §3.2):
 *
 * - If not trashed/spammed: `__all` applies.
 * - For each label: `TRASH`/`SPAM` always add their own key; another system
 *   label adds its key unless trashed/spammed; a user label adds its key
 *   unless trashed/spammed OR archived.
 * - `__scheduled` applies with the `SCHEDULED` label, `sendStatus` ===
 *   `'scheduled'`, and not trashed/spammed.
 */
export function folderKeys(input: FolderKeyInput): FolderKey[] {
  if (input.deletedAt) return [];
  const labels = [...new Set(input.labels ?? [])];
  const tos = isInTrashOrSpam({ labels, isTrash: input.isTrash, isSpam: input.isSpam });
  const archived = isArchived(labels);

  const keys = new Set<FolderKey>(['__total']);
  if (!tos) keys.add('__all');

  for (const label of labels) {
    if (label === SYSTEM_LABELS.TRASH || label === SYSTEM_LABELS.SPAM) {
      keys.add(label.toLowerCase());
      continue;
    }
    if (SYSTEM_LABEL_VALUES.has(label)) {
      if (!tos) keys.add(label.toLowerCase());
      continue;
    }
    // A user label.
    if (!tos && !archived) keys.add(label.toLowerCase());
  }

  if (labels.includes(SYSTEM_LABELS.SCHEDULED) && input.sendStatus === 'scheduled' && !tos) {
    keys.add('__scheduled');
  }

  return [...keys];
}

// ---------------------------------------------------------------------------
// Mail rule evaluation (ported from mail-inbound-worker's email-storage.ts:
// `evalRuleCondition` ~1657-1725 and `inboundRuleMatches` ~1518-1540). The
// worker still reads the rule rows and decides scope/stop-processing; this is
// only the pure per-condition decision.
// ---------------------------------------------------------------------------

export interface MailRuleCondition {
  field: string;
  operator: string;
  value: string;
}

export interface MailRuleAction {
  type: string;
  labelId?: string;
  value?: string;
}

/** The message fields a rule condition can read. Extra fields on the real row are ignored. */
export interface MailRuleMessage {
  from?: { email?: string | null } | null;
  to?: Array<{ email?: string | null }> | null;
  cc?: Array<{ email?: string | null }> | null;
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  hasAttachments?: boolean | null;
  sizeBytes?: number | null;
  isSpam?: boolean | null;
  priority?: string | null;
}

/** Evaluate one rule condition against a message. Ported verbatim from `evalRuleCondition`. */
export function evalRuleCondition(message: MailRuleMessage, condition: MailRuleCondition): boolean {
  let fieldValue: unknown;
  switch (condition.field) {
    case 'from':
      fieldValue = message.from?.email || '';
      break;
    case 'to':
      fieldValue = message.to?.map((t) => t.email).join(', ') || '';
      break;
    case 'cc':
      fieldValue = message.cc?.map((c) => c.email).join(', ') || '';
      break;
    case 'subject':
      fieldValue = message.subject || '';
      break;
    case 'body':
      fieldValue = message.textBody || message.htmlBody || '';
      break;
    case 'has_attachment':
      fieldValue = message.hasAttachments;
      break;
    case 'size':
      fieldValue = message.sizeBytes || 0;
      break;
    case 'is_spam':
      fieldValue = message.isSpam;
      break;
    case 'priority':
      fieldValue = message.priority || 'normal';
      break;
    default:
      return false;
  }

  const v = condition.value;
  switch (condition.operator) {
    case 'contains':
      return typeof fieldValue === 'string' && fieldValue.toLowerCase().includes(v.toLowerCase());
    case 'not_contains':
      return typeof fieldValue === 'string' && !fieldValue.toLowerCase().includes(v.toLowerCase());
    case 'equals':
      return typeof fieldValue === 'string'
        ? fieldValue.toLowerCase() === v.toLowerCase()
        : String(fieldValue) === v;
    case 'not_equals':
      return typeof fieldValue === 'string'
        ? fieldValue.toLowerCase() !== v.toLowerCase()
        : String(fieldValue) !== v;
    case 'starts_with':
      return typeof fieldValue === 'string' && fieldValue.toLowerCase().startsWith(v.toLowerCase());
    case 'ends_with':
      return typeof fieldValue === 'string' && fieldValue.toLowerCase().endsWith(v.toLowerCase());
    case 'greater_than':
      return !Number.isNaN(Number(fieldValue)) && !Number.isNaN(Number(v)) && Number(fieldValue) > Number(v);
    case 'less_than':
      return !Number.isNaN(Number(fieldValue)) && !Number.isNaN(Number(v)) && Number(fieldValue) < Number(v);
    case 'is_true':
      return fieldValue === true || fieldValue === 'true';
    case 'is_false':
      return fieldValue === false || fieldValue === 'false';
    default:
      return false;
  }
}

/** A mail rule's scope/folder/condition shape, as much as matching needs. */
export interface MailRuleMatchInput {
  scope?: string | null;
  folders?: readonly string[] | null;
  conditions?: readonly MailRuleCondition[] | null;
  matchType?: string | null;
}

/** Whether a mail rule applies to an inbound message: scope, then folder restriction, then its conditions. Ported from `inboundRuleMatches`. */
export function inboundRuleMatches(
  rule: MailRuleMatchInput,
  message: MailRuleMessage & { labels?: readonly string[] | null },
): boolean {
  // Inbound emails only match 'incoming' or 'all'.
  if (rule.scope === 'outgoing') return false;

  const folders = rule.folders;
  if (folders && folders.length > 0) {
    const msgLabels = message.labels ?? [];
    if (!folders.some((f) => msgLabels.includes(f))) return false;
  }

  const conditions = rule.conditions ?? [];
  const matchType = rule.matchType ?? 'all';
  if (conditions.length === 0) return false;

  return matchType === 'all'
    ? conditions.every((c) => evalRuleCondition(message, c))
    : conditions.some((c) => evalRuleCondition(message, c));
}

// ---------------------------------------------------------------------------
// Rule actions on an in-memory message state (ported from email-storage.ts
// ~1727-1810: `SIMPLE_RULE_ACTIONS`, `LABEL_RULE_ACTIONS`,
// `SPAM_DISPLACED_LABELS`, `markMessageAsSpam`, `applyLabelRule`,
// `executeRuleAction`/`executeRuleActions`). The worker read the row and
// wrote each action back one at a time; `inbound.finalize` instead folds
// every matched rule's actions into one state before the first write.
// ---------------------------------------------------------------------------

export interface RuleMessageState {
  labels: string[];
  isRead: boolean;
  isFlagged: boolean;
  isSpam: boolean;
  deleted: boolean;
}

/** Rule actions that set plain fields on the message state. */
const SIMPLE_RULE_ACTIONS = new Map<string, (state: RuleMessageState) => RuleMessageState>([
  ['delete', (state) => ({ ...state, deleted: true })],
  ['mark_as_read', (state) => ({ ...state, isRead: true })],
  ['mark_as_unread', (state) => ({ ...state, isRead: false })],
  ['flag', (state) => ({ ...state, isFlagged: true })],
]);

/** Folder labels a message leaves when a rule sends it to Spam. */
const SPAM_DISPLACED_LABELS = new Set<string>(['INBOX', 'ARCHIVE', 'PROMOTIONS']);

/**
 * Rule actions that rewrite the label list. `apply` returns the new labels,
 * or `null` when nothing needs to change.
 */
const LABEL_RULE_ACTIONS = new Map<
  string,
  { needsLabel: boolean; apply: (cur: string[], labelId: string | undefined) => string[] | null }
>([
  [
    'move_to_folder',
    { needsLabel: true, apply: (cur, labelId) => [...new Set([...cur.filter((l) => l !== 'INBOX'), labelId!])] },
  ],
  ['star', { needsLabel: false, apply: (cur) => (cur.includes('STARRED') ? null : [...cur, 'STARRED']) }],
  [
    'add_label',
    { needsLabel: true, apply: (cur, labelId) => (cur.includes(labelId!) ? null : [...cur, labelId!]) },
  ],
  ['remove_label', { needsLabel: true, apply: (cur, labelId) => cur.filter((l) => l !== labelId) }],
  ['archive', { needsLabel: false, apply: (cur) => [...new Set([...cur.filter((l) => l !== 'INBOX'), 'ARCHIVE'])] }],
]);

/** `mark_as_spam`: move to the Spam folder and set `isSpam`, as storing a scored spam message does. */
function applySpamAction(state: RuleMessageState): RuleMessageState {
  const labels = state.labels.filter((l) => !SPAM_DISPLACED_LABELS.has(l));
  return { ...state, labels: [...new Set([...labels, 'SPAM'])], isSpam: true };
}

/**
 * Apply one rule action to a message's in-memory state. Returns the next
 * state and whether the action applied — an unknown action type, or a label
 * action missing its `labelId`, does not apply, mirroring `executeRuleAction`
 * returning `false` without touching the row.
 */
export function applyRuleAction(
  state: RuleMessageState,
  action: MailRuleAction,
): { state: RuleMessageState; applied: boolean } {
  if (action.type === 'mark_as_spam') return { state: applySpamAction(state), applied: true };

  const simple = SIMPLE_RULE_ACTIONS.get(action.type);
  if (simple) return { state: simple(state), applied: true };

  const labelRule = LABEL_RULE_ACTIONS.get(action.type);
  if (!labelRule || (labelRule.needsLabel && !action.labelId)) return { state, applied: false };
  const nextLabels = labelRule.apply(state.labels, action.labelId);
  return { state: nextLabels ? { ...state, labels: nextLabels } : state, applied: true };
}

/**
 * Apply every action of one rule, in order. Mirrors `executeRuleActions`: how
 * many actions applied, and whether any of them marked the message as spam.
 */
export function applyRuleActions(
  state: RuleMessageState,
  actions: readonly MailRuleAction[],
): { state: RuleMessageState; actionsApplied: number; markedSpam: boolean } {
  let next = state;
  let actionsApplied = 0;
  let markedSpam = false;
  for (const action of actions) {
    const result = applyRuleAction(next, action);
    next = result.state;
    if (!result.applied) continue;
    actionsApplied++;
    if (action.type === 'mark_as_spam') markedSpam = true;
  }
  return { state: next, actionsApplied, markedSpam };
}
