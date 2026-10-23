import { describe, expect, it } from 'vitest';
import { buildCallHistory, formatCallDuration, parseCallNotice, parseDurationText } from './call-history';

const sys = (id: string, authorId: string, content: string, createdAt: string, metadata?: unknown) => ({
  id,
  type: 'system',
  authorId,
  authorName: authorId === 'u1' ? 'Gert' : 'Daniel',
  content,
  createdAt,
  metadata,
});

describe('parseCallNotice', () => {
  it('reads the legacy notice texts', () => {
    expect(parseCallNotice(sys('a', 'u1', 'Gert started a voice call', ''))).toEqual({ event: 'started', callType: 'voice' });
    expect(parseCallNotice(sys('a', 'u1', 'Gert started a video call', ''))).toEqual({ event: 'started', callType: 'video' });
    expect(parseCallNotice(sys('a', 'u1', 'Missed call', ''))).toEqual({ event: 'ended', outcome: 'missed', duration: 0 });
    expect(parseCallNotice(sys('a', 'u1', 'Call ended — 47m 13s', ''))).toEqual({
      event: 'ended',
      outcome: 'answered',
      duration: 2833,
    });
    expect(parseCallNotice(sys('a', 'u1', 'Call ended', ''))?.outcome).toBe('answered');
  });

  it('prefers metadata over the text', () => {
    const notice = parseCallNotice(
      sys('a', 'u1', 'Missed call', '', { call: { callId: 'call_1', callType: 'voice', event: 'ended', outcome: 'declined', duration: 0 } }),
    );
    expect(notice?.outcome).toBe('declined');
    expect(notice?.callId).toBe('call_1');
  });

  it('ignores ordinary messages, whatever they say or carry', () => {
    expect(parseCallNotice({ type: 'message', content: 'Missed call' })).toBeNull();
    expect(parseCallNotice({ type: 'message', content: 'hi', metadata: { call: { event: 'ended' } } })).toBeNull();
    expect(parseCallNotice({ type: 'system', content: '[system:msg_1] pinned a message' })).toBeNull();
  });
});

describe('buildCallHistory', () => {
  it('folds each legacy end into the latest open call by the same author', () => {
    const { calls, folded } = buildCallHistory([
      sys('s1', 'u1', 'Gert started a voice call', '2026-10-23T09:00:00Z'),
      sys('e1', 'u1', 'Missed call', '2026-10-23T09:00:25Z'),
      sys('s2', 'u2', 'Daniel started a voice call', '2026-10-23T09:01:00Z'),
      sys('e2', 'u2', 'Call ended — 47m 13s', '2026-10-23T09:48:13Z'),
    ]);
    expect([...folded]).toEqual(['e1', 'e2']);
    expect(calls.get('s1')).toMatchObject({ outcome: 'missed', initiatorId: 'u1', endedAt: '2026-10-23T09:00:25Z' });
    expect(calls.get('s2')).toMatchObject({ outcome: 'answered', duration: 2833, initiatorName: 'Daniel' });
  });

  it('pairs tagged notices by call id', () => {
    const { calls, folded } = buildCallHistory([
      sys('s1', 'u1', 'Gert started a video call', '1', { call: { callId: 'c1', callType: 'video', event: 'started' } }),
      sys('s2', 'u1', 'Gert started a voice call', '2', { call: { callId: 'c2', callType: 'voice', event: 'started' } }),
      sys('e1', 'u1', 'Call ended — 5s', '3', { call: { callId: 'c1', callType: 'video', event: 'ended', outcome: 'answered', duration: 5 } }),
    ]);
    expect(folded.has('e1')).toBe(true);
    expect(calls.get('s1')).toMatchObject({ callType: 'video', outcome: 'answered', duration: 5 });
    expect(calls.get('s2')?.outcome).toBeUndefined();
  });

  it('keeps an end whose start is not loaded as its own row', () => {
    const { calls, folded } = buildCallHistory([sys('e1', 'u2', 'Call ended — 1m', '1')]);
    expect(folded.size).toBe(0);
    expect(calls.get('e1')).toMatchObject({ endOnly: true, outcome: 'answered', duration: 60 });
  });
});

describe('durations', () => {
  it('parses and formats', () => {
    expect(parseDurationText('1h 2m 3s')).toBe(3723);
    expect(parseDurationText('2:34')).toBe(154);
    expect(parseDurationText('soon')).toBeUndefined();
    expect(formatCallDuration(45)).toBe('45s');
    expect(formatCallDuration(2833)).toBe('47m 13s');
    expect(formatCallDuration(120)).toBe('2m');
    expect(formatCallDuration(3900)).toBe('1h 05m');
  });
});
