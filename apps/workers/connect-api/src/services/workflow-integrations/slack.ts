/**
 * Slack-specific helpers for the generic `/api/workflow-integrations` surface
 * — the reference provider. A future provider (Google Sheets, GitHub, …) adds
 * its own small file here, keyed to one decrypted access token, never a Hono
 * context — see "Provider pattern" in docs/plans/weldconnect.md.
 */

export interface SlackChannelOption {
  id: string;
  name: string;
  isPrivate: boolean;
  /** Whether WeldSuite's Slack app is already a member — posting to a private
   *  channel needs this; public channels the app can join on send. */
  isMember: boolean;
}

interface SlackConversationsListResponse {
  ok: boolean;
  error?: string;
  channels?: Array<{ id: string; name: string; is_private?: boolean; is_member?: boolean }>;
  response_metadata?: { next_cursor?: string };
}

const MAX_CHANNELS = 200;
const PAGE_SIZE = 200;

/**
 * Public + private channels the connected Slack app can see
 * (`conversations.list`), paginated up to `MAX_CHANNELS`. A private channel
 * still needs the app invited (`/invite @WeldSuite`) before a post to it
 * succeeds — `isMember` lets the picker flag that in the UI.
 */
export async function listSlackChannels(accessToken: string): Promise<SlackChannelOption[]> {
  const channels: SlackChannelOption[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: String(PAGE_SIZE),
    });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`https://slack.com/api/conversations.list?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json()) as SlackConversationsListResponse;
    if (!json.ok) throw new Error(`Slack error: ${json.error || 'unknown'}`);
    for (const c of json.channels ?? []) {
      channels.push({ id: c.id, name: c.name, isPrivate: !!c.is_private, isMember: !!c.is_member });
    }
    cursor = json.response_metadata?.next_cursor || undefined;
  } while (cursor && channels.length < MAX_CHANNELS);
  return channels.slice(0, MAX_CHANNELS);
}

/** `auth.test` — a cheap, side-effect-free reachability check. */
export async function testSlackAuth(accessToken: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json()) as { ok: boolean; team?: string; error?: string };
  return { ok: json.ok, message: json.ok ? `Connected to ${json.team ?? 'Slack'}` : json.error ?? 'auth.test failed' };
}
