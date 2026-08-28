import React from 'react';
import { View, StyleSheet } from 'react-native';
import { tint } from '@/lib/brand';

/** Rounded tinted square holding a lucide icon — same motif as WeldBooks. */
export function IconTile({
  icon: Icon,
  color,
  size = 38,
}: {
  icon: React.ComponentType<{ size: number; color: string }>;
  color: string;
  size?: number;
}) {
  return (
    <View
      style={[
        styles.iconTile,
        { width: size, height: size, borderRadius: size / 3.2, backgroundColor: tint(color) },
      ]}
    >
      <Icon size={size * 0.5} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  iconTile: { alignItems: 'center', justifyContent: 'center' },
});
