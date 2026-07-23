import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, ViewStyle } from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';

const PULSE_DURATION = 1200;

function usePulse() {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: PULSE_DURATION,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: PULSE_DURATION,
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return opacity;
}

export function SkeletonBox({ width, height, radius = 4, style }: {
  width: number | `${number}%`;
  height: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const { colors } = useTheme();
  const opacity = usePulse();

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: colors.divider,
          opacity,
        },
        style,
      ]}
    />
  );
}

export function SkeletonCircle({ size, style }: { size: number; style?: ViewStyle }) {
  const { colors } = useTheme();
  const opacity = usePulse();

  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.divider,
          opacity,
        },
        style,
      ]}
    />
  );
}

/** Skeleton for a single conversation row in the inbox list */
function InboxRow() {
  return (
    <View style={sk.inboxRow}>
      <View style={{ flex: 1, gap: 8 }}>
        <View style={sk.inboxRowTop}>
          <SkeletonBox width={120} height={14} radius={6} />
          <SkeletonBox width={36} height={12} radius={6} />
        </View>
        <SkeletonBox width="80%" height={13} radius={6} />
        <SkeletonBox width="60%" height={12} radius={6} />
      </View>
    </View>
  );
}

/** Full-screen skeleton for the inbox list */
export function InboxSkeleton() {
  return (
    <View style={sk.container}>
      {/* Search bar placeholder */}
      <View style={sk.searchBar}>
        <SkeletonBox width="100%" height={36} radius={10} />
      </View>
      {/* Status filter row */}
      <View style={sk.filterRow}>
        <SkeletonBox width={48} height={28} radius={14} />
        <SkeletonBox width={56} height={28} radius={14} />
        <SkeletonBox width={64} height={28} radius={14} />
        <SkeletonBox width={56} height={28} radius={14} />
      </View>
      {/* Rows */}
      <InboxRow />
      <InboxRow />
      <InboxRow />
      <InboxRow />
      <InboxRow />
      <InboxRow />
      <InboxRow />
    </View>
  );
}

/** Skeleton for a chat message bubble */
function ChatBubble({ isRight, width }: { isRight: boolean; width: number | `${number}%` }) {
  return (
    <View style={[sk.bubble, isRight ? sk.bubbleRight : sk.bubbleLeft]}>
      <SkeletonBox width={width} height={40} radius={16} />
    </View>
  );
}

/** Full-screen skeleton for conversation chat screen */
export function ChatSkeleton() {
  const { colors } = useTheme();

  return (
    <View style={[sk.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={sk.chatHeader}>
        <SkeletonCircle size={36} />
        <View style={{ gap: 6, flex: 1 }}>
          <SkeletonBox width={140} height={14} radius={6} />
          <SkeletonBox width={90} height={11} radius={6} />
        </View>
      </View>
      {/* Messages */}
      <View style={sk.chatMessages}>
        <ChatBubble isRight={false} width="70%" />
        <ChatBubble isRight width="55%" />
        <ChatBubble isRight={false} width="85%" />
        <ChatBubble isRight={false} width="45%" />
        <ChatBubble isRight width="65%" />
      </View>
      {/* Input bar */}
      <View style={sk.chatInputBar}>
        <SkeletonBox width="100%" height={40} radius={20} />
      </View>
    </View>
  );
}

/** Skeleton for the contact detail screen */
export function ContactSkeleton() {
  return (
    <View style={sk.container}>
      {/* Avatar + name */}
      <View style={sk.contactTop}>
        <SkeletonCircle size={64} />
        <View style={{ gap: 6, alignItems: 'center' }}>
          <SkeletonBox width={160} height={18} radius={6} />
          <SkeletonBox width={200} height={13} radius={6} />
        </View>
      </View>
      {/* Fields */}
      <View style={sk.contactFields}>
        {[1, 2, 3, 4].map((i) => (
          <View key={i} style={sk.contactField}>
            <SkeletonBox width={80} height={12} radius={6} />
            <SkeletonBox width="60%" height={14} radius={6} />
          </View>
        ))}
      </View>
    </View>
  );
}

const sk = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 16,
  },
  // Inbox
  searchBar: {
    paddingTop: 12,
    paddingBottom: 4,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 12,
  },
  inboxRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  inboxRowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  // Chat
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  chatMessages: {
    flex: 1,
    paddingVertical: 20,
    gap: 16,
  },
  bubble: {
    maxWidth: '85%',
  },
  bubbleLeft: {
    alignSelf: 'flex-start',
  },
  bubbleRight: {
    alignSelf: 'flex-end',
  },
  chatInputBar: {
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.06)',
  },
  // Contact
  contactTop: {
    alignItems: 'center',
    gap: 12,
    paddingTop: 32,
    paddingBottom: 24,
  },
  contactFields: {
    gap: 20,
    paddingTop: 8,
  },
  contactField: {
    gap: 6,
  },
});
