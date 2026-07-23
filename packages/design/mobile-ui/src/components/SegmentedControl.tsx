import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii, Spacing } from '../constants/theme';

export interface SegmentedControlOption {
  label: string;
  value: string;
}

export interface SegmentedControlProps {
  options: SegmentedControlOption[];
  value: string;
  onValueChange: (value: string) => void;
  style?: StyleProp<ViewStyle>;
}

export function SegmentedControl({
  options,
  value,
  onValueChange,
  style,
}: SegmentedControlProps) {
  const { colors } = useTheme();

  return (
    <View
      style={[
        styles.track,
        { backgroundColor: colors.secondary },
        style,
      ]}
    >
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onValueChange(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
            style={({ pressed }) => [
              styles.segment,
              isActive && [
                styles.segmentActive,
                { backgroundColor: colors.card },
              ],
              !isActive && pressed && { opacity: 0.7 },
            ]}
          >
            <Text
              style={[
                styles.label,
                {
                  color: isActive ? colors.text : colors.mutedForeground,
                  fontWeight: isActive ? '600' : '400',
                },
              ]}
              numberOfLines={1}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default SegmentedControl;

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    borderRadius: Radii.md,
    padding: 2,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radii.sm,
    minHeight: 32,
  },
  segmentActive: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  label: {
    fontSize: 13,
  },
});
