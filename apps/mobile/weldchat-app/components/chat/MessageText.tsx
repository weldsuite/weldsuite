import { Text, View } from 'react-native';
import { Colors } from '@weldsuite/mobile-ui/constants/theme';

import type { ThemeColors } from '@/lib/theme-colors';
import { mentionLabel, mentionTokenRegex, splitInlineFiles } from '@/lib/chat/mentions';
import { findLinks } from '@/lib/chat/links';
import { openExternalUrl } from '@/utils/safe-url';

/**
 * Blurple mention badge colours for the active theme. The pale text that reads
 * well on black was near-invisible on the light theme's white.
 */
export function mentionBadgeColors(colors: ThemeColors) {
  return colors.background === Colors.dark.background
    ? { color: '#dee0fc', backgroundColor: 'rgba(88, 101, 242, 0.3)' }
    : { color: '#4752c4', backgroundColor: 'rgba(88, 101, 242, 0.15)' };
}

/** Plain text with its web addresses as tappable links. */
function renderLinks(text: string, keyPrefix: string, colors: ThemeColors): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const link of findLinks(text)) {
    if (link.start > lastIndex) parts.push(text.substring(lastIndex, link.start));
    parts.push(
      <Text
        key={`${keyPrefix}l${link.start}`}
        style={{ color: colors.info, textDecorationLine: 'underline' }}
        onPress={() => void openExternalUrl(link.href)}
        accessibilityRole="link"
      >
        {link.text}
      </Text>,
    );
    lastIndex = link.end;
  }
  if (lastIndex < text.length) parts.push(text.substring(lastIndex));
  return parts;
}

/** The message's own attachments, for the `<@file:…>` tokens placed in its text. */
export interface InlineAttachments<T extends { id: string }> {
  attachments: readonly T[];
  render: (attachment: T) => React.ReactNode;
}

/**
 * Render message text with `<@userId>` tokens as mention badges and links as
 * links. An inline `<@file:…>` token shows its attachment at that spot (when
 * `inline` has it) and is otherwise left out.
 */
export function renderMessageText<T extends { id: string }>(
  content: string,
  members: Map<string, string>,
  colors: ThemeColors,
  inline?: InlineAttachments<T>,
) {
  const byId = new Map((inline?.attachments ?? []).map((att) => [att.id, att]));
  const blocks = splitInlineFiles(content, new Set(byId.keys()));
  if (blocks.length === 1 && blocks[0].kind === 'text') {
    return renderTextRun(blocks[0].text, members, colors);
  }
  if (blocks.length === 0) return null;
  return (
    <View style={{ gap: 6 }}>
      {blocks.map((block, i) => {
        if (block.kind === 'text') {
          return <View key={`t${i}`}>{renderTextRun(block.text, members, colors)}</View>;
        }
        const att = byId.get(block.attachmentId);
        return att && inline ? <View key={`f${i}`}>{inline.render(att)}</View> : null;
      })}
    </View>
  );
}

function renderTextRun(content: string, members: Map<string, string>, colors: ThemeColors) {
  const textStyle = { fontSize: 15, lineHeight: 22, color: colors.text };
  const mentionBadgeStyle = {
    fontSize: 14,
    fontWeight: '700',
    borderRadius: 4,
    paddingHorizontal: 2,
    overflow: 'hidden',
    ...mentionBadgeColors(colors),
  } as const;
  const mentionRegex = mentionTokenRegex();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = mentionRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Text key={`t${match.index}`} style={textStyle}>
          {renderLinks(content.substring(lastIndex, match.index), `t${match.index}`, colors)}
        </Text>,
      );
    }
    parts.push(
      <Text key={`m${match.index}`} style={mentionBadgeStyle}>@{mentionLabel(match[1], members)}</Text>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(
      <Text key="end" style={textStyle}>
        {renderLinks(content.substring(lastIndex), 'end', colors)}
      </Text>,
    );
  }

  if (parts.length === 0) {
    return <Text style={textStyle}>{content}</Text>;
  }

  return <Text style={textStyle}>{parts}</Text>;
}
