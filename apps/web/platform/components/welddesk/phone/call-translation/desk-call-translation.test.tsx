/**
 * The Translate control on a live inbound call and its captions panel: hidden
 * without the AI, a dialog that starts the translation (default "Detect"),
 * captions as they arrive, Stop, and the inline banners for the refusals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { ApiError } from '@weldsuite/api-client';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns], getLocale: () => 'en' };
});

const gate = vi.hoisted(() => ({ available: true }));
vi.mock('@/app/welddesk/inbox/translation/translation-state', () => ({
  useDeskTranslationAvailable: () => gate.available,
}));

interface Mutation {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
}
const api = vi.hoisted(() => ({
  state: null as unknown,
  start: { mutate: vi.fn(), isPending: false } as Mutation,
  update: { mutate: vi.fn(), isPending: false } as Mutation,
  stop: { mutate: vi.fn(), isPending: false } as Mutation,
}));
vi.mock('@/hooks/queries/use-desk-call-translation-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/queries/use-desk-call-translation-queries')>();
  return {
    ...actual,
    useDeskCallTranslation: () => ({ data: api.state }),
    useStartDeskCallTranslation: () => api.start,
    useUpdateDeskCallTranslation: () => api.update,
    useStopDeskCallTranslation: () => api.stop,
  };
});

import { DeskCallTranslation } from './desk-call-translation';
import { CallCaptionsPanel } from './call-captions-panel';
import { CallTranslationDialog } from './call-translation-dialog';
import { deskCallTranslationAtom, withCaption, withTranslationEvent } from './call-translation-state';

const store = getDefaultStore();
const CALL = 'vcall_1';

const running = (values: Record<string, unknown> = {}) => ({
  callId: CALL,
  active: true,
  callerLanguage: null,
  agentLanguage: 'en',
  speakToCaller: true,
  speakAvailable: false,
  startedAt: '2026-11-10T10:00:00.000Z',
  startedById: 'user_me',
  stoppedAt: null,
  ...values,
});

const line = (id: string, speaker: 'caller' | 'agent', text: string, translation: string | null, at: string) => ({
  callId: CALL,
  lineId: id,
  speaker,
  text,
  translation,
  sourceLanguage: speaker === 'caller' ? 'nl' : 'en',
  targetLanguage: speaker === 'caller' ? 'en' : 'nl',
  at,
});

beforeEach(() => {
  gate.available = true;
  api.state = null;
  for (const m of [api.start, api.update, api.stop]) {
    m.mutate.mockReset();
    m.isPending = false;
  }
  store.set(deskCallTranslationAtom, null);
});
afterEach(() => cleanup());

describe('DeskCallTranslation', () => {
  it('renders nothing without the AI or the permission', () => {
    gate.available = false;
    const { container } = render(<DeskCallTranslation callId={CALL} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers a Translate button that opens the dialog with "Detect" chosen', () => {
    render(<DeskCallTranslation callId={CALL} />);
    expect(screen.queryByTestId('call-translation-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('call-translate-button'));
    const dialog = screen.getByTestId('call-translation-dialog');
    expect(within(dialog).getByText('Translate this call')).toBeTruthy();
    expect(within(screen.getByTestId('call-translation-caller')).getByText('Detect')).toBeTruthy();
    // Nothing to speak to until the caller's language is known.
    expect(screen.getByTestId('call-translation-speak').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('call-translation-speak-hint').textContent).toContain('once the caller');
  });

  it('starts with the chosen languages and closes on success', () => {
    api.start.mutate.mockImplementation((_input, options: { onSuccess: () => void }) => options.onSuccess());
    render(<DeskCallTranslation callId={CALL} />);
    fireEvent.click(screen.getByTestId('call-translate-button'));
    fireEvent.click(screen.getByTestId('call-translation-submit'));
    expect(api.start.mutate).toHaveBeenCalledWith(
      { callerLanguage: 'auto', agentLanguage: 'en', speakToCaller: true },
      expect.anything(),
    );
    expect(screen.queryByTestId('call-translation-dialog')).toBeNull();
  });

  it('shows no-credits and AI-unavailable as inline banners', () => {
    api.start.mutate.mockImplementation((_input, options: { onError: (e: unknown) => void }) =>
      options.onError(new ApiError('Payment required', 402)),
    );
    render(<DeskCallTranslation callId={CALL} />);
    fireEvent.click(screen.getByTestId('call-translate-button'));
    fireEvent.click(screen.getByTestId('call-translation-submit'));
    expect(screen.getByTestId('call-translation-error').textContent).toContain('no AI credits left');

    api.start.mutate.mockImplementation((_input, options: { onError: (e: unknown) => void }) =>
      options.onError(new ApiError('Unavailable', 503, { error: { code: 'ai_unavailable' } })),
    );
    fireEvent.click(screen.getByTestId('call-translate-button'));
    fireEvent.click(screen.getByTestId('call-translation-submit'));
    expect(screen.getByTestId('call-translation-error').textContent).toContain('AI is currently unavailable');
  });

  it('shows the live captions of a running translation and stops it', () => {
    api.state = running();
    render(<DeskCallTranslation callId={CALL} />);
    expect(screen.queryByTestId('call-translate-button')).toBeNull();
    expect(screen.getByTestId('call-captions-empty')).toBeTruthy();
    expect(screen.getByTestId('call-captions-language').textContent).toBe('Detecting the caller’s language…');

    act(() => {
      store.set(deskCallTranslationAtom, (prev) =>
        withCaption(prev, line('l1', 'caller', 'Ik wil mijn pakket volgen', 'I want to track my parcel', '2026-11-10T10:00:05Z')),
      );
      store.set(deskCallTranslationAtom, (prev) =>
        withTranslationEvent(prev, { callId: CALL, active: true, callerLanguage: 'nl', speakAvailable: true, stoppedReason: null }),
      );
    });
    expect(screen.getByTestId('call-caption-translation').textContent).toBe('I want to track my parcel');
    expect(screen.getByTestId('call-caption-original').textContent).toBe('Ik wil mijn pakket volgen');
    expect(screen.getByTestId('call-captions-language').textContent).toBe('Caller speaks Dutch');
    expect(screen.getByTestId('call-captions-voice').textContent).toBe('Spoken to the caller');

    fireEvent.click(screen.getByTestId('call-captions-stop'));
    expect(api.stop.mutate).toHaveBeenCalled();
  });

  it('explains when the system stopped the translation', () => {
    api.state = running();
    render(<DeskCallTranslation callId={CALL} />);
    act(() => {
      store.set(deskCallTranslationAtom, (prev) =>
        withTranslationEvent(prev, { callId: CALL, active: false, callerLanguage: null, speakAvailable: false, stoppedReason: 'no_credits' }),
      );
    });
    expect(screen.getByTestId('call-translation-stopped').textContent).toContain('out of AI credits');
    expect(screen.getByTestId('call-translate-button')).toBeTruthy();
  });

  it('forgets the lines when the call ends', () => {
    api.state = running();
    const { unmount } = render(<DeskCallTranslation callId={CALL} />);
    act(() => {
      store.set(deskCallTranslationAtom, (prev) => withCaption(prev, line('l1', 'agent', 'Hello', 'Hallo', '2026-11-10T10:00:05Z')));
    });
    unmount();
    expect(store.get(deskCallTranslationAtom)).toBeNull();
  });
});

describe('CallTranslationDialog', () => {
  const dialog = (callerLanguage: string) => (
    <CallTranslationDialog
      open
      onOpenChange={vi.fn()}
      initial={{ callerLanguage, agentLanguage: 'en', speakToCaller: true }}
      editing={false}
      pending={false}
      onSubmit={vi.fn()}
    />
  );

  it('disables speaking, with a hint, for a language that has no voice', () => {
    render(dialog('uk'));
    expect(screen.getByTestId('call-translation-speak').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('call-translation-speak-hint').textContent).toBe(
      'No voice is available for Ukrainian: you get captions only.',
    );
  });

  it('lets the agent speak to a caller whose language has a voice', () => {
    render(dialog('nl'));
    expect(screen.getByTestId('call-translation-speak').hasAttribute('disabled')).toBe(false);
  });
});

describe('CallCaptionsPanel', () => {
  const panel = (lines: ReturnType<typeof line>[], extra: Partial<Parameters<typeof CallCaptionsPanel>[0]> = {}) => (
    <CallCaptionsPanel
      lines={lines}
      callerLanguage="uk"
      speakAvailable={false}
      speakToCaller
      stopping={false}
      onChange={vi.fn()}
      onStop={vi.fn()}
      {...extra}
    />
  );

  it('shows each line with its speaker, the translation prominent and the original small', () => {
    render(
      panel([
        line('l1', 'caller', 'Привіт', 'Hello', '2026-11-10T10:00:01Z'),
        line('l2', 'agent', 'How can I help?', 'Чим можу допомогти?', '2026-11-10T10:00:03Z'),
        line('l3', 'caller', 'Thanks', null, '2026-11-10T10:00:05Z'),
      ]),
    );
    const lines = screen.getAllByTestId('call-caption-line');
    expect(lines.map((l) => l.getAttribute('data-speaker'))).toEqual(['caller', 'agent', 'caller']);
    expect(within(lines[0]!).getByText('Caller')).toBeTruthy();
    expect(within(lines[1]!).getByText('You')).toBeTruthy();
    expect(within(lines[1]!).getByTestId('call-caption-translation').textContent).toBe('Чим можу допомогти?');
    // Same language on both sides: the text once.
    expect(within(lines[2]!).getByTestId('call-caption-text').textContent).toBe('Thanks');
    expect(within(lines[2]!).queryByTestId('call-caption-original')).toBeNull();
    expect(screen.getByTestId('call-captions-voice').textContent).toBe('Captions only: no voice for this language.');
  });

  it('scrolls to the newest line', () => {
    const { rerender } = render(panel([line('l1', 'caller', 'a1', 'b1', '2026-11-10T10:00:01Z')]));
    const log = screen.getByTestId('call-captions-log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 480 });
    rerender(panel([line('l1', 'caller', 'a1', 'b1', '2026-11-10T10:00:01Z'), line('l2', 'caller', 'a2', 'b2', '2026-11-10T10:00:02Z')]));
    expect(log.scrollTop).toBe(480);
  });
});

describe('call translation state', () => {
  it('keeps lines in time order, once each, per call', () => {
    let live = withCaption(null, line('l2', 'caller', 'b', 'B', '2026-11-10T10:00:02Z'));
    live = withCaption(live, line('l1', 'caller', 'a', 'A', '2026-11-10T10:00:01Z'));
    live = withCaption(live, line('l1', 'caller', 'a', 'A', '2026-11-10T10:00:01Z'));
    expect(live.lines.map((l) => l.lineId)).toEqual(['l1', 'l2']);
    const other = withCaption(live, { ...line('l9', 'caller', 'z', 'Z', '2026-11-10T10:00:09Z'), callId: 'vcall_2' });
    expect(other.callId).toBe('vcall_2');
    expect(other.lines).toHaveLength(1);
  });
});
