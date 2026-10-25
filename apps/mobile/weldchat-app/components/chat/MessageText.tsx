import { Text } from 'react-native';

import type { ThemeColors } from '@/lib/theme-colors';
import { mentionLabel, mentionTokenRegex } from '@/lib/chat/mentions';
import { findLinks } from '@/lib/chat/links';
import { openExternalUrl } from '@/utils/safe-url';

const mentionBadgeStyle = {
  fontSize: 14,
  fontWeight: '700',
  color: '#dee0fc',
  backgroundColor: 'rgba(88, 101, 242, 0.3)',
  borderRadius: 4,
  paddingHorizontal: 2,
  overflow: 'hidden',
} as const;

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

/** Render message text with `<@userId>` tokens as mention badges and links as links. */
export function renderMessageText(content: string, members: Map<string, string>, colors: ThemeColors) {
  const textStyle = { fontSize: 15, lineHeight: 22, color: colors.text };
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
