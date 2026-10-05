/**
 * Debounced draft autosave, shared by the full-page compose and the floating
 * compose panel (see `use-draft-autosave.ts` for the React binding).
 *
 * Rules the class enforces:
 * - the first autosave creates the draft, every later one updates that same
 *   draft; nothing is created for a blank form;
 * - saves run strictly one after another, so a create can never race a second
 *   create (or an update that still needs the new id);
 * - the first snapshot handed to `schedule` is the baseline (a pre-filled reply,
 *   or the draft that was just opened) and is not saved on its own;
 * - `discard` (after a send, or an explicit delete) cancels pending work, waits
 *   for the in-flight save and deletes the draft, and nothing saves afterwards.
 */

/** What a draft stores. Empty values are sent as-is so clearing a field persists. */
export interface DraftFields {
  subject: string;
  to: string[];
  cc: string[];
  bcc: string[];
  /** Tag-free text part. */
  body: string;
  /** Markup part. */
  htmlBody: string;
  inReplyTo?: string;
}

export interface DraftPersistence {
  /** Creates the draft and resolves to its id. */
  create(accountId: string, fields: DraftFields): Promise<string>;
  update(draftId: string, fields: DraftFields): Promise<void>;
  remove(draftId: string): Promise<void>;
}

export type DraftChange = 'created' | 'updated' | 'deleted';
export type DraftDiscardResult = 'deleted' | 'none' | 'failed';

export interface DraftAutosaverOptions {
  persistence: DraftPersistence;
  /** Resolved at save time; a save is skipped while it returns nothing. */
  getAccountId: () => string | undefined;
  /** Existing draft to keep updating (an opened draft). */
  draftId?: string | null;
  /** Quiet time after the last change before saving. */
  debounceMs?: number;
  /** Longest a pending change may wait while the user keeps typing. */
  maxWaitMs?: number;
  onChange?: (change: DraftChange) => void;
}

export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 2000;
export const DEFAULT_AUTOSAVE_MAX_WAIT_MS = 10000;

export function isDraftBlank(fields: DraftFields): boolean {
  return (
    !fields.subject.trim() &&
    fields.to.length === 0 &&
    fields.cc.length === 0 &&
    fields.bcc.length === 0 &&
    !fields.body.trim()
  );
}

// What counts as a change. `inReplyTo` is left out on purpose: compose fills it
// in after mounting for a reply, and that alone must not create a draft.
const fieldsKey = (fields: DraftFields): string =>
  JSON.stringify([fields.subject, fields.to, fields.cc, fields.bcc, fields.body, fields.htmlBody]);

export class DraftAutosaver {
  private readonly persistence: DraftPersistence;
  private readonly getAccountId: () => string | undefined;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly onChange?: (change: DraftChange) => void;

  private id: string | null;
  private latest: DraftFields | null = null;
  private baselined = false;
  private savedKey: string | null = null;
  private dirty = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: DraftAutosaverOptions) {
    this.persistence = options.persistence;
    this.getAccountId = options.getAccountId;
    this.debounceMs = options.debounceMs ?? DEFAULT_AUTOSAVE_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_AUTOSAVE_MAX_WAIT_MS;
    this.onChange = options.onChange;
    this.id = options.draftId ?? null;
  }

  get draftId(): string | null {
    return this.id;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Reports the current form state; saves it after the quiet period. */
  schedule(fields: DraftFields): void {
    if (this.closed) return;
    this.latest = fields;

    if (!this.baselined) {
      this.baselined = true;
      this.savedKey = fieldsKey(fields);
      return;
    }
    if (fieldsKey(fields) === this.savedKey) {
      this.dirty = false;
      this.clearTimer();
      return;
    }

    this.dirty = true;
    const now = Date.now();
    if (this.timer === null) this.firstPendingAt = now;
    else clearTimeout(this.timer);
    const budget = Math.max(0, this.firstPendingAt + this.maxWaitMs - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue(false);
    }, Math.min(this.debounceMs, budget));
  }

  /**
   * Saves right away (the explicit "Save draft" action). Resolves to false when
   * the save failed. Unlike autosave it also creates a draft for an unchanged,
   * pre-filled form, because the user asked for it.
   */
  async save(fields: DraftFields): Promise<boolean> {
    if (this.closed) return true;
    this.latest = fields;
    this.clearTimer();
    return this.enqueue(true);
  }

  /** Saves whatever is still pending, then stops the saver (compose is closing). */
  async finish(): Promise<void> {
    if (this.closed) return;
    this.clearTimer();
    // A save can finish while newer edits are waiting, so go around again; a
    // failed save ends the loop (nothing more can be done for it here).
    while (this.dirty) {
      this.clearTimer();
      if (!(await this.enqueue(false))) break;
    }
    this.closed = true;
    this.clearTimer();
  }

  /** Cancels pending saves and deletes the draft, if one exists (after send or delete). */
  async discard(): Promise<DraftDiscardResult> {
    if (this.closed && this.id === null) return 'none';
    this.closed = true;
    this.dirty = false;
    this.clearTimer();
    await this.queue;
    const id = this.id;
    if (!id) return 'none';
    try {
      await this.persistence.remove(id);
      this.id = null;
      this.onChange?.('deleted');
      return 'deleted';
    } catch {
      return 'failed';
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private enqueue(explicit: boolean): Promise<boolean> {
    const run = this.queue.then(() => this.persist(explicit));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(explicit: boolean): Promise<boolean> {
    const fields = this.latest;
    if (!fields || this.closed) return true;

    const key = fieldsKey(fields);
    const id = this.id;
    // Nothing changed since the last save (or since the baseline). An explicit
    // save still creates a draft that has none yet.
    if (key === this.savedKey && (id || !explicit)) {
      this.dirty = false;
      return true;
    }
    // Never create a draft out of an empty form.
    if (!id && isDraftBlank(fields)) {
      this.dirty = false;
      return true;
    }

    try {
      if (id) {
        await this.persistence.update(id, fields);
        this.onChange?.('updated');
      } else {
        const accountId = this.getAccountId();
        if (!accountId) return false;
        this.id = await this.persistence.create(accountId, fields);
        this.onChange?.('created');
      }
      this.savedKey = key;
      this.dirty = false;
      // Changes that arrived while this save was in flight still need saving.
      if (this.latest && fieldsKey(this.latest) !== key) this.schedule(this.latest);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * A saver handed from one compose surface to the other (minimize / expand), so
 * the draft the first surface already created keeps being updated instead of a
 * second one being created.
 */
interface Handoff {
  saver: DraftAutosaver;
  accountId: string | undefined;
  at: number;
}

const HANDOFF_TTL_MS = 30_000;
let pendingHandoff: Handoff | null = null;

export function offerDraftHandoff(saver: DraftAutosaver, accountId: string | undefined): void {
  pendingHandoff = { saver, accountId, at: Date.now() };
}

export function takeDraftHandoff(accountId: string | undefined): DraftAutosaver | null {
  const handoff = pendingHandoff;
  pendingHandoff = null;
  if (!handoff || handoff.saver.isClosed) return null;
  if (Date.now() - handoff.at > HANDOFF_TTL_MS) return null;
  if (handoff.accountId && accountId && handoff.accountId !== accountId) return null;
  return handoff.saver;
}
