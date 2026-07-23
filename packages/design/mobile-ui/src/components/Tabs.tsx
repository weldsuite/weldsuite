import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Spacing } from '../constants/theme';

export interface TabItem {
  key: string;
  label: string;
}

export interface TabsProps {
  tabs: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  scrollable?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Tabs({
  tabs,
  activeKey,
  onChange,
  scrollable = true,
  style,
}: TabsProps) {
  const { colors } = useTheme();

  const content = (
    <>
      {tabs.map((tab) => {
        const isActive = tab.key === activeKey;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            style={({ pressed }) => [
              styles.tab,
              !isActive && pressed && { opacity: 0.7 },
            ]}
          >
            <Text
              style={[
                styles.tabLabel,
                {
                  color: isActive ? colors.text : colors.mutedForeground,
                  fontWeight: isActive ? '600' : '400',
                },
              ]}
            >
              {tab.label}
            </Text>
            {isActive && (
              <View
                style={[styles.indicator, { backgroundColor: colors.primary }]}
              />
            )}
          </Pressable>
        );
      })}
    </>
  );

  if (scrollable) {
    return (
      <View
        style={[
          styles.wrapper,
          { borderBottomColor: colors.border },
          style,
        ]}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
        >
          {content}
        </ScrollView>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.wrapper,
        styles.row,
        { borderBottomColor: colors.border },
        style,
      ]}
    >
      {content}
    </View>
  );
}

export default Tabs;

const styles = StyleSheet.create({
  wrapper: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
  },
  scrollContent: {
    flexDirection: 'row',
  },
  tab: {
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: 0,
    position: 'relative',
  },
  tabLabel: {
    fontSize: 14,
    paddingBottom: Spacing.sm,
  },
  indicator: {
    position: 'absolute',
    bottom: 0,
    left: Spacing.lg,
    right: Spacing.lg,
    height: 2,
    borderRadius: 1,
  },
});
