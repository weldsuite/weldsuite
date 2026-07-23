/**
 * Slack inbound — signature verification + event parsing for WeldConnect
 * `integration_event` triggers. Deliberately lean (verify + parse only); it does
 * not implement the CRM-record-shaped `IntegrationProvider` interface.
 */

const FIVE_MINUTES = 60 * 5;

function bytesToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Verify a Slack request signature (`v0=` HMAC-SHA256 over
 * `v0:timestamp:rawBody`). Rejects requests older than 5 minutes (replay
 * protection).
 */
export async function verifySlackSignature(
  signingSecret: string | undefined,
  timestamp: string | null,
  rawBody: string,
  signature: string | null,
): Promise<boolean> {
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > FIVE_MINUTES) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`));
  return timingSafeEqual(`v0=${bytesToHex(mac)}`, signature);
}

export interface ParsedSlackEvent {
  event: string;
  teamId: string;
  data: Record<string, unknown>;
}

/** Parse a Slack Events API `event_callback` JSON payload into a WeldConnect
 *  trigger event. Ignores bot messages + message subtypes (edits/joins). */
export function parseSlackEventCallback(payload: any): ParsedSlackEvent | null {
  if (payload?.type !== 'event_callback' || !payload.event) return null;
  const ev = payload.event;
  const teamId = String(payload.team_id ?? '');
  if (!teamId) return null;

  if (ev.type === 'message' && !ev.bot_id && !ev.subtype) {
    return {
      event: 'slack.message',
      teamId,
      data: { channel: ev.channel, user: ev.user, text: ev.text, ts: ev.ts, team_id: teamId },
    };
  }
  return null;
}

/** Parse a Slack slash-command (form-encoded) payload. */
export function parseSlackSlashCommand(form: Record<string, string>): ParsedSlackEvent | null {
  const teamId = form.team_id;
  if (!teamId) return null;
  return {
    event: 'slack.slash_command',
    teamId,
    data: {
      command: form.command,
      text: form.text,
      user_id: form.user_id,
      channel_id: form.channel_id,
      team_id: teamId,
    },
  };
}
