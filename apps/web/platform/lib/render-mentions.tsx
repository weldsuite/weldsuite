import React from 'react';

/**
 * Render plain text containing `<@userId>` mention tokens (the same wire
 * format used by WeldChat) as inline badges. Falls back to the raw userId
 * when no display name is available in `members`.
 *
 * Keep visually in sync with the badge in
 * `apps/web/platform/app/weldchat/components/message-item.tsx`.
 */
export function renderContentWithMentions(
  text: string,
  members?: Map<string, string>,
): React.ReactNode {
  if (!text) return text;
  const mentionRegex = /<@([^>]+)>/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }
    const userId = match[1];
    const name = userId.includes(':')
      ? userId.split(':')[1]
      : members?.get(userId) ?? userId;

    parts.push(
      <span
        key={`mention-${match.index}`}
        className="inline-block bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 rounded px-1.5 py-0.5 text-[12px] font-medium align-middle"
      >
        @{name}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}
