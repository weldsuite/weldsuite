/**
 * Which messages render as a system notice chip.
 *
 * A notice is a `type: 'system'` message. Its content may carry a
 * `[system:<messageId>] text` prefix (pin alerts do, to link to the pinned
 * message). The prefix is honoured ONLY on real system messages: a member can
 * type `[system:x] was removed by an admin` into an ordinary message, and that
 * must not render as an official notice.
 *
 * Rows written before the server posted pin alerts as `type: 'system'` are
 * plain messages with exactly `[system:msg_…] pinned a message`; that one
 * shape is still honoured.
 */

const SYSTEM_PREFIX = /^\[system(?::([^\]]+))?\] (.+)$/;
const LEGACY_PIN_NOTICE = /^\[system:(msg_[a-z0-9]+)\] (pinned a message)$/;

interface SystemNoticeCandidate {
  type?: string | null;
  content?: string | null;
}

/**
 * `[1]` = linked message id (if any), `[2]` = notice text — or null when the
 * message has no recognised prefix (or isn't allowed to have one).
 */
export function matchSystemNotice(message: SystemNoticeCandidate): RegExpMatchArray | null {
  const content = message.content ?? '';
  return message.type === 'system' ? SYSTEM_PREFIX.exec(content) : LEGACY_PIN_NOTICE.exec(content);
}

/** True when the message should render as a system notice chip rather than a chat message. */
export function isSystemNotice(message: SystemNoticeCandidate): boolean {
  return message.type === 'system' || matchSystemNotice(message) !== null;
}
