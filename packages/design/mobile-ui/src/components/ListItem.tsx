import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Spacing } from '../constants/theme';

export interface ListItemProps {
  title: string;
  subtitle?: string;
  leftElement?: React.ReactNode;
  rightElement?: React.ReactNode;
  showChevron?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  divider?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function ListItem({
  title,
  subtitle,
  leftElement,
  rightElement,
  showChevron = false,
  onPress,
  disabled = false,
  destructive = false,
  divider = false,
  style,
}: ListItemProps) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.container,
        {
          backgroundColor: pressed && !disabled ? colors.pressed : 'transparent',
          borderBottomColor: colors.divider,
          borderBottomWidth: divider ? StyleSheet.hairlineWidth : 0,
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      {leftElement != null && (
        <View style={styles.leftElement}>{leftElement}</View>
      )}
      <View style={styles.textContainer}>
        <Text
          style={[
            styles.title,
            { color: destructive ? colors.destructive : colors.text },
          ]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle != null && (
          <Text
            style={[styles.subtitle, { color: colors.mutedForeground }]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        )}
      </View>
      {rightElement != null && (
        <View style={styles.rightElement}>{rightElement}</View>
      )}
      {showChevron && (
        <ChevronRight size={18} color={colors.mutedForeground} />
      )}
    </Pressable>
  );
}

export default ListItem;

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    gap: Spacing.md,
  },
  leftElement: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  textContainer: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 16,
    fontWeight: '400',
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
  },
  rightElement: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
