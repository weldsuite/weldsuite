/**
 * A person as a rounded square: their photo, or white initials on a colour
 * that stays the same for the same name. `badge` pins a small tile to the
 * corner (the leave type of someone who is off).
 *
 * In a list it is as tall as the coloured bar next to a two-line row
 * (`BAR_HEIGHT`), with or without a bar, so every person row lines up.
 */

import type { ReactNode } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { avatarColorFor } from '@/constants/brand';
import { usePalette } from '@/hooks/use-palette';
import { BAR_HEIGHT } from './Row';

/** The corner badge's tile on a list-size avatar. */
export const AVATAR_BADGE = 14;

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return (words[0].charAt(0) + words.at(-1)!.charAt(0)).toUpperCase();
}

export function PersonAvatar({
  name,
  url,
  size = BAR_HEIGHT,
  badge,
}: Readonly<{ name: string; url?: string | null; size?: number; badge?: ReactNode }>) {
  const palette = usePalette();
  const radius = Math.round(size * 0.34);
  return (
    <View style={{ width: size, height: size }} accessibilityLabel={name}>
      {url ? (
        <View style={[styles.clip, { width: size, height: size, borderRadius: radius, backgroundColor: palette.tile }]}>
          <Image source={{ uri: url }} style={{ width: size, height: size }} />
        </View>
      ) : (
        <View
          style={[styles.fill, styles.smooth, { width: size, height: size, borderRadius: radius, backgroundColor: avatarColorFor(name) }]}
        >
          <Text style={[styles.initials, { fontSize: Math.round(size * 0.36) }]}>{initials(name)}</Text>
        </View>
      )}
      {badge ? <View style={[styles.badge, { borderColor: palette.surface }]}>{badge}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { alignItems: 'center', justifyContent: 'center' },
  smooth: { borderCurve: 'continuous' },
  clip: { overflow: 'hidden', borderCurve: 'continuous' },
  initials: { color: '#FFFFFF', fontWeight: '600', letterSpacing: 0.2 },
  // Sits out on the corner, clear of the initials.
  badge: { position: 'absolute', right: -6, bottom: -6, borderWidth: 2, borderRadius: 7, borderCurve: 'continuous' },
});
