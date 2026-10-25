import { Text } from 'react-native';
import { Colors } from '@weldsuite/mobile-ui/constants/theme';

import type { ThemeColors } from '@/lib/theme-colors';
import { mentionLabel, mentionTokenRegex } from '@/lib/chat/mentions';

/**
 * Blurple mention badge colours for the active theme. The pale text that reads
 * well on black was near-invisible on the light theme's white.
 */
export function mentionBadgeColors(colors: ThemeColors) {
  return colors.background === Colors.dark.background
    ? { color: '#dee0fc', backgroundColor: 'rgba(88, 101, 242, 0.3)' }
    : { color: '#4752c4', backgroundColor: 'rgba(88, 101, 242, 0.15)' };
}

/** Render message text with `<@userId>` tokens as mention badges. */
export function renderMessageText(content: string, members: Map<string, string>, colors: ThemeColors) {
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
      parts.push(<Text key={`t${match.index}`} style={textStyle}>{content.substring(lastIndex, match.index)}</Text>);
    }
    parts.push(
      <Text key={`m${match.index}`} style={mentionBadgeStyle}>@{mentionLabel(match[1], members)}</Text>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(<Text key="end" style={textStyle}>{content.substring(lastIndex)}</Text>);
  }

  if (parts.length === 0) {
    return <Text style={textStyle}>{content}</Text>;
  }

  return <Text style={textStyle}>{parts}</Text>;
}
