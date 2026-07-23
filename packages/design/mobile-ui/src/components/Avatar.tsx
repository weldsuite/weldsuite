import React from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii } from '../constants/theme';

export interface AvatarProps {
  source?: { uri: string };
  name?: string;
  size?: number;
  shape?: 'circle' | 'square';
  style?: StyleProp<ViewStyle>;
}

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}

export function Avatar({ source, name, size = 40, shape = 'circle', style }: AvatarProps) {
  const { colors } = useTheme();
  const borderRadius = shape === 'circle' ? size / 2 : Radii.md;
  const fontSize = Math.round(size * 0.4);

  const containerStyle = [
    styles.container,
    {
      width: size,
      height: size,
      borderRadius,
      backgroundColor: colors.secondary,
    },
    style,
  ];

  if (source) {
    return (
      <View style={containerStyle}>
        <Image
          source={source}
          style={[styles.image, { borderRadius }]}
          accessibilityLabel={name ?? 'Avatar'}
        />
      </View>
    );
  }

  const initials = name ? getInitials(name) : '';

  return (
    <View style={containerStyle} accessibilityLabel={name ?? 'Avatar'}>
      <Text style={[styles.initials, { fontSize, color: colors.secondaryForeground }]}>
        {initials}
      </Text>
    </View>
  );
}

export default Avatar;

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  initials: {
    fontWeight: '600',
  },
});
