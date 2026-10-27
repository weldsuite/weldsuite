/**
 * Completing the WebSocket close handshake from a `webSocketClose` handler.
 *
 * On this worker's compatibility date the runtime does not answer a client's
 * Close frame itself, so each handler calls `ws.close(code, reason)`. The code
 * it was handed cannot always be sent back: 1005 (no code given — the browser's
 * bare `ws.close()`) and 1006 (connection lost — a laptop going to sleep, a
 * dropped network, a killed app) describe a close, they are not codes a peer
 * may send, and `ws.close` throws on them. A throw there aborts the rest of the
 * handler, which is how the WorkspaceHub used to leave people "online" for good.
 */

/** A close code that may go back on the wire: the given one, or 1000. */
export function replyCode(code: number): number {
  const sendable = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
  return sendable ? code : 1000;
}

/** Reciprocate a close without ever throwing (the socket may already be gone). */
export function reciprocateClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(replyCode(code), reason);
  } catch {
    // Already closed.
  }
}
