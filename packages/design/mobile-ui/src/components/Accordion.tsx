import React, { useRef, useState } from 'react';
import {
  Animated,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Spacing } from '../constants/theme';

// Enable LayoutAnimation on Android.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export interface AccordionItem {
  key: string;
  title: string;
  content: React.ReactNode;
}

export interface AccordionProps {
  items: AccordionItem[];
  allowMultiple?: boolean;
  defaultOpenKeys?: string[];
  style?: StyleProp<ViewStyle>;
}

interface AccordionRowProps {
  item: AccordionItem;
  isOpen: boolean;
  isLast: boolean;
  onToggle: (key: string) => void;
}

function AccordionRow({ item, isOpen, isLast, onToggle }: AccordionRowProps) {
  const { colors } = useTheme();
  const rotation = useRef(new Animated.Value(isOpen ? 1 : 0)).current;

  const handleToggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    Animated.timing(rotation, {
      toValue: isOpen ? 0 : 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
    onToggle(item.key);
  };

  const rotateInterpolate = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'],
  });

  return (
    <View
      style={[
        styles.rowWrapper,
        !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
      ]}
    >
      <Pressable
        onPress={handleToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: isOpen }}
        style={({ pressed }) => [
          styles.header,
          { backgroundColor: pressed ? colors.pressed : 'transparent' },
        ]}
      >
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {item.title}
        </Text>
        <Animated.View style={{ transform: [{ rotate: rotateInterpolate }] }}>
          <ChevronDown size={18} color={colors.mutedForeground} />
        </Animated.View>
      </Pressable>
      {isOpen && (
        <View style={styles.content}>{item.content}</View>
      )}
    </View>
  );
}

export function Accordion({
  items,
  allowMultiple = false,
  defaultOpenKeys = [],
  style,
}: AccordionProps) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set(defaultOpenKeys));

  const handleToggle = (key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        if (!allowMultiple) {
          next.clear();
        }
        next.add(key);
      }
      return next;
    });
  };

  return (
    <View style={style}>
      {items.map((item, index) => (
        <AccordionRow
          key={item.key}
          item={item}
          isOpen={openKeys.has(item.key)}
          isLast={index === items.length - 1}
          onToggle={handleToggle}
        />
      ))}
    </View>
  );
}

export default Accordion;

const styles = StyleSheet.create({
  rowWrapper: {},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
    minHeight: 48,
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '400',
  },
  content: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
  },
});
