import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DraftAutosaver,
  isDraftBlank,
  offerDraftHandoff,
  takeDraftHandoff,
  type DraftFields,
  type DraftPersistence,
} from './draft-autosave';

const fields = (overrides: Partial<DraftFields> = {}): DraftFields => ({
  subject: '',
  to: [],
  cc: [],
  bcc: [],
  body: '',
  htmlBody: '',
  ...overrides,
});

const DEBOUNCE = 1000;
const MAX_WAIT = 5000;

function setup(options: { draftId?: string | null; accountId?: string } = {}) {
  let nextId = 1;
  const persistence = {
    create: vi.fn(async (_accountId: string, _fields: DraftFields) => `draft_${nextId++}`),
    update: vi.fn(async (_draftId: string, _fields: DraftFields) => undefined),
    remove: vi.fn(async (_draftId: string) => undefined),
  } satisfies DraftPersistence;
  const onChange = vi.fn();
  const saver = new DraftAutosaver({
    persistence,
    getAccountId: () => ('accountId' in options ? options.accountId : 'acct_1'),
    draftId: options.draftId ?? null,
    debounceMs: DEBOUNCE,
    maxWaitMs: MAX_WAIT,
    onChange,
  });
  return { saver, persistence, onChange };
}

const typed = (text: string) => fields({ to: ['a@example.com'], subject: 'Hi', body: text, htmlBody: text });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isDraftBlank', () => {
  it('is blank without recipients, subject or text', () => {
    expect(isDraftBlank(fields())).toBe(true);
    expect(isDraftBlank(fields({ subject: '  ', body: ' \n', htmlBody: '<div><br></div>' }))).toBe(true);
  });

  it('has content with any recipient, subject or text', () => {
    expect(isDraftBlank(fields({ to: ['a@example.com'] }))).toBe(false);
    expect(isDraftBlank(fields({ cc: ['a@example.com'] }))).toBe(false);
    expect(isDraftBlank(fields({ subject: 'Hello' }))).toBe(false);
    expect(isDraftBlank(fields({ body: 'Hello' }))).toBe(false);
  });
});

describe('DraftAutosaver', () => {
  it('does not save the first snapshot (the baseline)', async () => {
    const { saver, persistence } = setup();
    saver.schedule(typed('pre-filled'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 3);
    expect(persistence.create).not.toHaveBeenCalled();
  });

  it('creates the draft once the user changes something, then updates the same draft', async () => {
    const { saver, persistence, onChange } = setup();
    saver.schedule(fields());
    saver.schedule(typed('a'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(persistence.create).toHaveBeenCalledTimes(1);
    expect(persistence.create).toHaveBeenCalledWith('acct_1', typed('a'));
    expect(saver.draftId).toBe('draft_1');
    expect(onChange).toHaveBeenLastCalledWith('created');

    saver.schedule(typed('ab'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(persistence.create).toHaveBeenCalledTimes(1);
    expect(persistence.update).toHaveBeenCalledWith('draft_1', typed('ab'));
    expect(onChange).toHaveBeenLastCalledWith('updated');
  });

  it('never creates a draft for a blank form', async () => {
    const { saver, persistence } = setup();
    saver.schedule(typed('x'));
    saver.schedule(fields());
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 3);
    expect(persistence.create).not.toHaveBeenCalled();
    expect(persistence.update).not.toHaveBeenCalled();
  });

  it('debounces: only the last of several quick changes is saved', async () => {
    const { saver, persistence } = setup();
    saver.schedule(fields());
    for (const text of ['a', 'ab', 'abc']) {
      saver.schedule(typed(text));
      await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
    }
    expect(persistence.create).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(persistence.create).toHaveBeenCalledTimes(1);
    expect(persistence.create).toHaveBeenCalledWith('acct_1', typed('abc'));
  });

  it('still saves while the user keeps typing past the max wait', async () => {
    const { saver, persistence } = setup();
    saver.schedule(fields());
    let text = '';
    for (let elapsed = 0; elapsed < MAX_WAIT + DEBOUNCE; elapsed += DEBOUNCE / 2) {
      text += 'x';
      saver.schedule(typed(text));
      await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
    }
    expect(persistence.create).toHaveBeenCalledTimes(1);
  });

  it('does not race two creates when typing continues during a slow create', async () => {
    const { saver, persistence } = setup();
    let finishCreate: (id: string) => void = () => undefined;
    persistence.create.mockImplementationOnce(
      () => new Promise<string>((resolve) => { finishCreate = resolve; }),
    );

    saver.schedule(fields());
    saver.schedule(typed('a'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(persistence.create).toHaveBeenCalledTimes(1);

    saver.schedule(typed('ab'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    // The second save waits for the create to resolve; it must be an update.
    expect(persistence.create).toHaveBeenCalledTimes(1);
    expect(persistence.update).not.toHaveBeenCalled();

    finishCreate('draft_slow');
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    expect(persistence.create).toHaveBeenCalledTimes(1);
    expect(persistence.update).toHaveBeenCalledWith('draft_slow', typed('ab'));
  });

  it('keeps updating an opened draft instead of creating a new one', async () => {
    const { saver, persistence } = setup({ draftId: 'draft_open' });
    saver.schedule(typed('loaded'));
    saver.schedule(typed('loaded and edited'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(persistence.create).not.toHaveBeenCalled();
    expect(persistence.update).toHaveBeenCalledWith('draft_open', typed('loaded and edited'));
  });

  it('skips a save when nothing changed since the last one', async () => {
    const { saver, persistence } = setup();
    saver.schedule(fields());
    saver.schedule(typed('a'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    saver.schedule(typed('a'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    expect(persistence.create).toHaveBeenCalledTimes(1);
    expect(persistence.update).not.toHaveBeenCalled();
  });

  it('does not treat a reply id arriving after mount as a change', async () => {
    const { saver, persistence } = setup();
    saver.schedule(typed('quoted reply'));
    saver.schedule({ ...typed('quoted reply'), inReplyTo: 'msg_1' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    expect(persistence.create).not.toHaveBeenCalled();
  });

  it('saves clearing a field (empty values are sent, not dropped)', async () => {
    const { saver, persistence } = setup({ draftId: 'draft_open' });
    saver.schedule(typed('text'));
    saver.schedule(fields({ to: ['a@example.com'], subject: 'Hi' }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(persistence.update).toHaveBeenCalledWith(
      'draft_open',
      expect.objectContaining({ body: '', htmlBody: '' }),
    );
  });

  it('retries on the next change after a failed save', async () => {
    const { saver, persistence } = setup();
    persistence.create.mockRejectedValueOnce(new Error('offline'));
    saver.schedule(fields());
    saver.schedule(typed('a'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(saver.draftId).toBeNull();

    saver.schedule(typed('ab'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(persistence.create).toHaveBeenCalledTimes(2);
    expect(saver.draftId).toBe('draft_1');
  });

  describe('save (explicit)', () => {
    it('creates a draft for a pre-filled form nobody edited', async () => {
      const { saver, persistence } = setup();
      saver.schedule(typed('pre-filled'));
      await expect(saver.save(typed('pre-filled'))).resolves.toBe(true);
      expect(persistence.create).toHaveBeenCalledTimes(1);
    });

    it('updates the autosaved draft rather than creating a second one', async () => {
      const { saver, persistence } = setup();
      saver.schedule(fields());
      saver.schedule(typed('a'));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await saver.save(typed('ab'));
      expect(persistence.create).toHaveBeenCalledTimes(1);
      expect(persistence.update).toHaveBeenCalledWith('draft_1', typed('ab'));
    });

    it('cancels the pending autosave and reports a failure', async () => {
      const { saver, persistence } = setup();
      persistence.create.mockRejectedValueOnce(new Error('boom'));
      saver.schedule(fields());
      saver.schedule(typed('a'));
      await expect(saver.save(typed('a'))).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
      expect(persistence.create).toHaveBeenCalledTimes(1);
    });

    it('fails when no account is known yet', async () => {
      const { saver, persistence } = setup({ accountId: undefined });
      await expect(saver.save(typed('a'))).resolves.toBe(false);
      expect(persistence.create).not.toHaveBeenCalled();
    });

    it('does nothing for a blank form', async () => {
      const { saver, persistence } = setup();
      await expect(saver.save(fields())).resolves.toBe(true);
      expect(persistence.create).not.toHaveBeenCalled();
    });
  });

  describe('finish', () => {
    it('saves pending changes immediately, then stops saving', async () => {
      const { saver, persistence } = setup();
      saver.schedule(fields());
      saver.schedule(typed('a'));
      await saver.finish();
      expect(persistence.create).toHaveBeenCalledTimes(1);

      saver.schedule(typed('ab'));
      await vi.advanceTimersByTimeAsync(DEBOUNCE * 3);
      expect(persistence.update).not.toHaveBeenCalled();
    });

    it('waits for a create that is still in flight', async () => {
      const { saver, persistence } = setup();
      let finishCreate: (id: string) => void = () => undefined;
      persistence.create.mockImplementationOnce(
        () => new Promise<string>((resolve) => { finishCreate = resolve; }),
      );
      saver.schedule(fields());
      saver.schedule(typed('a'));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      saver.schedule(typed('ab'));
      const finished = saver.finish();
      finishCreate('draft_slow');
      await finished;
      expect(persistence.create).toHaveBeenCalledTimes(1);
      expect(persistence.update).toHaveBeenCalledWith('draft_slow', typed('ab'));
    });
  });

  describe('discard', () => {
    it('deletes the draft and cancels pending autosaves', async () => {
      const { saver, persistence, onChange } = setup();
      saver.schedule(fields());
      saver.schedule(typed('a'));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      saver.schedule(typed('ab'));

      await expect(saver.discard()).resolves.toBe('deleted');
      expect(persistence.remove).toHaveBeenCalledWith('draft_1');
      expect(onChange).toHaveBeenLastCalledWith('deleted');

      await vi.advanceTimersByTimeAsync(DEBOUNCE * 3);
      expect(persistence.update).not.toHaveBeenCalled();
      expect(persistence.create).toHaveBeenCalledTimes(1);
    });

    it('deletes the draft a still-running create produces', async () => {
      const { saver, persistence } = setup();
      let finishCreate: (id: string) => void = () => undefined;
      persistence.create.mockImplementationOnce(
        () => new Promise<string>((resolve) => { finishCreate = resolve; }),
      );
      saver.schedule(fields());
      saver.schedule(typed('a'));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      const discarded = saver.discard();
      finishCreate('draft_late');
      await expect(discarded).resolves.toBe('deleted');
      expect(persistence.remove).toHaveBeenCalledWith('draft_late');
    });

    it('deletes an opened draft that was never edited', async () => {
      const { saver, persistence } = setup({ draftId: 'draft_open' });
      await expect(saver.discard()).resolves.toBe('deleted');
      expect(persistence.remove).toHaveBeenCalledWith('draft_open');
    });

    it('has nothing to delete when no draft exists', async () => {
      const { saver, persistence } = setup();
      await expect(saver.discard()).resolves.toBe('none');
      expect(persistence.remove).not.toHaveBeenCalled();
    });

    it('reports a failed delete', async () => {
      const { saver, persistence } = setup({ draftId: 'draft_open' });
      persistence.remove.mockRejectedValueOnce(new Error('nope'));
      await expect(saver.discard()).resolves.toBe('failed');
    });
  });
});

describe('draft handoff', () => {
  it('passes the saver to the next compose surface once', () => {
    const { saver } = setup();
    offerDraftHandoff(saver, 'acct_1');
    expect(takeDraftHandoff('acct_1')).toBe(saver);
    expect(takeDraftHandoff('acct_1')).toBeNull();
  });

  it('refuses a saver for another account', () => {
    const { saver } = setup();
    offerDraftHandoff(saver, 'acct_1');
    expect(takeDraftHandoff('acct_2')).toBeNull();
  });

  it('refuses a stale or finished saver', async () => {
    const { saver } = setup();
    offerDraftHandoff(saver, 'acct_1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(takeDraftHandoff('acct_1')).toBeNull();

    const { saver: finished } = setup();
    await finished.finish();
    offerDraftHandoff(finished, 'acct_1');
    expect(takeDraftHandoff('acct_1')).toBeNull();
  });
});
