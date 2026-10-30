/**
 * The sidebar's list of live calls (`GET /chat-calls/active`), one entry per
 * conversation with a call, drawn as the green phone on its row.
 *
 * Push events (`call_started` / `call_ended` on the user's topic) keep it
 * current, but a push missed while the socket was down (laptop asleep, tab in
 * the background) left a call on the list for good: the green phone stayed
 * while the conversation itself showed no call. The open conversation checks
 * its own call every few seconds (`GET /chat-calls/active/:channelId`, which
 * also ends calls left behind), so its answer corrects that row.
 */

export interface ActiveCallEntry {
  channelId: string;
  callId: string;
  callType: 'voice' | 'video';
}

export const ACTIVE_CALLS_KEY = ['weldchat', 'active-calls'] as const;

/**
 * The list with one conversation's entry set to what that conversation's own
 * check found (`null`: no call). The same array when nothing changes, so a
 * check that agrees does not re-render the sidebar.
 */
export function withChannelCall(
  list: readonly ActiveCallEntry[],
  channelId: string,
  call: { id: string; callType?: string | null } | null,
): ActiveCallEntry[] {
  const listed = list.find((entry) => entry.channelId === channelId);
  if (!call) {
    return listed ? list.filter((entry) => entry.channelId !== channelId) : (list as ActiveCallEntry[]);
  }
  const callType = call.callType === 'video' ? 'video' : 'voice';
  if (listed?.callId === call.id && listed.callType === callType) return list as ActiveCallEntry[];
  return [...list.filter((entry) => entry.channelId !== channelId), { channelId, callId: call.id, callType }];
}
