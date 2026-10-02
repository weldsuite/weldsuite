/**
 * @weldsuite/cloudflare-realtime additions the recorder depends on, exercised
 * through its RTK_FETCH test seam (the SDK holds its own fetch reference).
 */

import { describe, expect, it } from 'vitest';
import {
  createMeeting,
  generateSessionSummary,
  getRecording,
  getSessionSummary,
  getSessionTranscript,
  mapLocaleToRtkLanguage,
  updateMeeting,
  type CloudflareRealtimeEnv,
} from '@weldsuite/cloudflare-realtime';

interface Seen {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

function rtk(respond: (seen: Seen) => unknown = () => ({ success: true, data: { id: 'rtk_1', title: 't', status: 'ACTIVE' } })) {
  const seen: Seen[] = [];
  const env: CloudflareRealtimeEnv = {
    CF_ACCOUNT_ID: 'acct',
    CF_REALTIME_APP_ID: 'app',
    CF_REALTIME_APP_SECRET: 'secret',
    RTK_FETCH: async (input, init) => {
      const entry: Seen = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      };
      seen.push(entry);
      return new Response(JSON.stringify(respond(entry)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
  return { env, seen };
}

describe('createMeeting', () => {
  it('sends exactly the old body without options (WeldChat calls are unchanged)', async () => {
    const { env, seen } = rtk();
    await createMeeting(env, 'Call');
    expect(seen[0]!.body).toEqual({ title: 'Call' });
  });

  it('sends record_on_start and the MP3 audio export only when asked', async () => {
    const { env, seen } = rtk();
    await createMeeting(env, 'Sync', { recordOnStart: true, audioExport: true });
    expect(seen[0]!.body).toEqual({
      title: 'Sync',
      record_on_start: true,
      recording_config: { audio_config: { export_file: true, codec: 'MP3' } },
    });
  });

  it('does not send record_on_start when auto-record is off but audio export is on', async () => {
    const { env, seen } = rtk();
    await createMeeting(env, 'Sync', { recordOnStart: false, audioExport: true });
    expect(seen[0]!.body).toMatchObject({ record_on_start: false });
    expect(seen[0]!.body).not.toHaveProperty('transcribe_on_end');
  });

  it('passes the post-meeting AI options and language', async () => {
    const { env, seen } = rtk();
    await createMeeting(env, 'Sync', {
      transcribeOnEnd: true,
      summarizeOnEnd: true,
      transcriptionLanguage: 'nl',
      summaryTextFormat: 'markdown',
    });
    expect(seen[0]!.body).toMatchObject({
      transcribe_on_end: true,
      summarize_on_end: true,
      ai_config: { transcription: { language: 'nl' }, summarization: { text_format: 'markdown' } },
    });
  });
});

describe('updateMeeting', () => {
  it('PATCHes the live meeting with only the fields given', async () => {
    const { env, seen } = rtk();
    await updateMeeting(env, 'rtk_live', { transcribeOnEnd: true, summarizeOnEnd: false, transcriptionLanguage: 'de' });
    expect(seen[0]!.method).toBe('PATCH');
    expect(seen[0]!.url).toContain('/meetings/rtk_live');
    expect(seen[0]!.body).toEqual({
      transcribe_on_end: true,
      summarize_on_end: false,
      ai_config: { transcription: { language: 'de' } },
    });
  });
});

describe('mapLocaleToRtkLanguage', () => {
  it('maps platform locales to RealtimeKit codes and everything else to auto-detect', () => {
    expect(mapLocaleToRtkLanguage('en')).toBe('en-US');
    expect(mapLocaleToRtkLanguage('en-GB')).toBe('en-US');
    expect(mapLocaleToRtkLanguage('en-IN')).toBe('en-IN');
    expect(mapLocaleToRtkLanguage('nl')).toBe('nl');
    expect(mapLocaleToRtkLanguage('nl_NL')).toBe('nl');
    for (const code of ['de', 'fr', 'sv', 'pl', 'ru', 'el', 'hi']) expect(mapLocaleToRtkLanguage(code)).toBe(code);
    expect(mapLocaleToRtkLanguage('es')).toBeUndefined();
    expect(mapLocaleToRtkLanguage('auto')).toBeUndefined();
    expect(mapLocaleToRtkLanguage('')).toBeUndefined();
    expect(mapLocaleToRtkLanguage(null)).toBeUndefined();
  });
});

describe('recordings and session artifacts', () => {
  it('exposes the audio URL, expiry, duration and session of a recording', async () => {
    const { env } = rtk(() => ({
      success: true,
      data: {
        id: 'rec_1',
        status: 'UPLOADED',
        download_url: 'https://rtk/v.mp4',
        audio_download_url: 'https://rtk/a.mp3',
        download_url_expiry: '2026-10-09T00:00:00Z',
        file_size: 10,
        recording_duration: 61,
        session_id: 'sess_1',
        output_file_name: 'v.mp4',
        started_time: null,
        stopped_time: null,
      },
    }));
    expect(await getRecording(env, 'rec_1')).toMatchObject({
      audio_download_url: 'https://rtk/a.mp3',
      download_url_expiry: '2026-10-09T00:00:00Z',
      recording_duration: 61,
      session_id: 'sess_1',
      output_file_name: 'v.mp4',
    });
  });

  it('fetches transcript (JSON) and summary download URLs for a session', async () => {
    const { env, seen } = rtk((req) =>
      req.url.includes('/transcript')
        ? { success: true, data: { sessionId: 's', transcript_download_url: 'https://rtk/t.json', transcript_download_url_expiry: 'e1' } }
        : { success: true, data: { sessionId: 's', summaryDownloadUrl: 'https://rtk/s.md', summaryDownloadUrlExpiry: 'e2' } },
    );
    expect(await getSessionTranscript(env, 'sess_1')).toEqual({ downloadUrl: 'https://rtk/t.json', expiresAt: 'e1' });
    expect(seen[0]!.url).toMatch(/\/sessions\/sess_1\/transcript\?format=JSON/);
    expect(await getSessionSummary(env, 'sess_1')).toEqual({ downloadUrl: 'https://rtk/s.md', expiresAt: 'e2' });
  });

  it('reports a session without a transcript, and can ask RealtimeKit to generate a summary', async () => {
    const { env, seen } = rtk(() => ({ success: true, data: {} }));
    await expect(getSessionTranscript(env, 'sess_x')).rejects.toThrow(/no transcript/);
    await generateSessionSummary(env, 'sess_x');
    expect(seen.at(-1)).toMatchObject({ method: 'POST' });
    expect(seen.at(-1)!.url).toContain('/sessions/sess_x/summary');
  });
});
