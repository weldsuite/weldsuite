import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Sparkles } from 'lucide-react-native';

interface WeldAgentLogoProps {
  size?: number;
  color?: string;
}

export default function WeldAgentLogo({ size = 24, color = '#000000' }: WeldAgentLogoProps) {
  return (
    <View style={[styles.container, { width: size * 1.5, height: size * 1.5, backgroundColor: color }]}>
      <Sparkles size={size * 0.7} color="#FFFFFF" strokeWidth={2} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 6,
  },
});
