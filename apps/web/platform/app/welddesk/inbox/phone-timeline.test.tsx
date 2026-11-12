/**
 * Voicemail on the timeline: a player for the recording with its length, and
 * the other phone events as centered lines instead of bubbles from an agent.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});

import type { DeskMessage } from '@/hooks/queries/use-desk-queries';
import { isPhoneTimelineMessage, PhoneTimelineRow, safeRecordingUrl } from './phone-timeline';

function message(metadata: DeskMessage['metadata'], overrides: Partial<DeskMessage> = {}): DeskMessage {
  return {
    id: 'dmsg_1',
    createdAt: '2026-11-09T10:15:00.000Z',
    conversationId: 'dconv_1',
    kind: 'message',
    body: 'Voicemail (23s)',
    authorType: 'system',
    authorId: null,
    attachments: null,
    metadata,
    ...overrides,
  };
}

describe('isPhoneTimelineMessage', () => {
  it.each(['voicemail', 'call_answered', 'call_missed', 'menu_choice', 'menu_no_choice', 'call_outbound', 'call_ended', 'recording_saved'])(
    'takes the %s event',
    (event) => {
      expect(isPhoneTimelineMessage(message({ event }))).toBe(true);
    },
  );

  it('leaves the voice agent transcript, agent messages and plain messages alone', () => {
    expect(isPhoneTimelineMessage(message({ event: 'ai_transcript', role: 'user' }))).toBe(false);
    expect(isPhoneTimelineMessage(message({ event: 'voicemail' }, { authorType: 'agent' }))).toBe(false);
    expect(isPhoneTimelineMessage(message(null))).toBe(false);
  });
});

describe('safeRecordingUrl', () => {
  it('only lets web addresses into the audio element', () => {
    expect(safeRecordingUrl('https://recordings.example.com/a.mp3')).toBe('https://recordings.example.com/a.mp3');
    expect(safeRecordingUrl('javascript:alert(1)')).toBeNull();
    expect(safeRecordingUrl(null)).toBeNull();
  });
});

describe('PhoneTimelineRow', () => {
  it('plays a voicemail and shows its length', () => {
    render(
      <PhoneTimelineRow
        message={message({ event: 'voicemail', callId: 'call_1', recordingUrl: 'https://recordings.example.com/a.mp3', duration: 23 })}
      />,
    );
    expect(screen.getByTestId('desk-inbox-voicemail')).toHaveTextContent('Voicemail');
    expect(screen.getByTestId('desk-inbox-voicemail-length')).toHaveTextContent('23 s');
    expect(screen.getByTestId('desk-inbox-voicemail-audio')).toHaveAttribute('src', 'https://recordings.example.com/a.mp3');
  });

  it('copes with a voicemail without a length', () => {
    render(<PhoneTimelineRow message={message({ event: 'voicemail', recordingUrl: 'https://recordings.example.com/a.mp3', duration: null })} />);
    expect(screen.queryByTestId('desk-inbox-voicemail-length')).toBeNull();
    expect(screen.getByTestId('desk-inbox-voicemail-audio')).toBeInTheDocument();
  });

  it('says so when the recording is missing or not a web address', () => {
    render(<PhoneTimelineRow message={message({ event: 'voicemail', recordingUrl: 'javascript:alert(1)' })} />);
    expect(screen.queryByTestId('desk-inbox-voicemail-audio')).toBeNull();
    expect(screen.getByText('The recording is not available.')).toBeInTheDocument();
  });

  it.each([
    ['call_answered', 'Call answered by Sam'],
    ['call_missed', 'Missed call'],
    ['call_outbound', 'Outbound call to +31612345678'],
  ])('shows %s as a line with its text', (event, body) => {
    render(<PhoneTimelineRow message={message({ event }, { body })} />);
    const line = screen.getByTestId('desk-inbox-phone-event');
    expect(line).toHaveTextContent(body);
    expect(line).toHaveAttribute('data-event', event);
  });
});
