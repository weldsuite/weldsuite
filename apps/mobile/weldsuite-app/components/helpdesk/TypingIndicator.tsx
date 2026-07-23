/**
 * Typing Indicator Component
 *
 * Shows animated dots and user name when someone is typing in a conversation.
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import type { TypingIndicator as TypingIndicatorType } from '@/hooks/useHelpdeskRealtime';

interface TypingIndicatorProps {
  users: TypingIndicatorType[];
}

export function TypingIndicator({ users }: TypingIndicatorProps) {
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animateDots = () => {
      const createDotAnimation = (dot: Animated.Value, delay: number) => {
        return Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, {
            toValue: 1,
            duration: 300,
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0.3,
            duration: 300,
            useNativeDriver: true,
          }),
        ]);
      };

      Animated.loop(
        Animated.parallel([
          createDotAnimation(dot1, 0),
          createDotAnimation(dot2, 150),
          createDotAnimation(dot3, 300),
        ])
      ).start();
    };

    animateDots();

    return () => {
      dot1.stopAnimation();
      dot2.stopAnimation();
      dot3.stopAnimation();
    };
  }, [dot1, dot2, dot3]);

  if (users.length === 0) {
    return null;
  }

  const getTypingText = () => {
    if (users.length === 1) {
      return `${users[0].userName || 'Someone'} is typing`;
    }
    if (users.length === 2) {
      return `${users[0].userName || 'Someone'} and ${users[1].userName || 'someone else'} are typing`;
    }
    return `${users.length} people are typing`;
  };

  return (
    <View style={styles.container}>
      <View style={styles.dotsContainer}>
        <Animated.View style={[styles.dot, { opacity: dot1 }]} />
        <Animated.View style={[styles.dot, { opacity: dot2 }]} />
        <Animated.View style={[styles.dot, { opacity: dot3 }]} />
      </View>
      <Text style={styles.text}>{getTypingText()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#f8f9fa',
  },
  dotsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#6b7280',
    marginHorizontal: 2,
  },
  text: {
    fontSize: 12,
    color: '#6b7280',
    fontStyle: 'italic',
  },
});
