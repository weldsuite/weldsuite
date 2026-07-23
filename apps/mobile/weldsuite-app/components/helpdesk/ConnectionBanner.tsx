/**
 * Connection Banner Component
 *
 * Shows the current connection status when not connected.
 */

import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react-native';
import type { ConnectionState } from '@weldsuite/realtime/types';

interface ConnectionBannerProps {
  state: ConnectionState;
  onRetry?: () => void;
}

const stateConfig: Record<
  ConnectionState,
  {
    backgroundColor: string;
    textColor: string;
    icon: 'connecting' | 'disconnected' | 'error' | 'hidden';
    message: string;
    showRetry: boolean;
  }
> = {
  initialized: {
    backgroundColor: '#fef3c7',
    textColor: '#92400e',
    icon: 'connecting',
    message: 'Initializing...',
    showRetry: false,
  },
  connecting: {
    backgroundColor: '#fef3c7',
    textColor: '#92400e',
    icon: 'connecting',
    message: 'Connecting...',
    showRetry: false,
  },
  connected: {
    backgroundColor: '#d1fae5',
    textColor: '#065f46',
    icon: 'hidden',
    message: 'Connected',
    showRetry: false,
  },
  disconnected: {
    backgroundColor: '#fee2e2',
    textColor: '#991b1b',
    icon: 'disconnected',
    message: 'Disconnected. Reconnecting...',
    showRetry: true,
  },
  suspended: {
    backgroundColor: '#fee2e2',
    textColor: '#991b1b',
    icon: 'disconnected',
    message: 'Connection suspended. Retrying...',
    showRetry: true,
  },
  closing: {
    backgroundColor: '#f3f4f6',
    textColor: '#4b5563',
    icon: 'connecting',
    message: 'Closing connection...',
    showRetry: false,
  },
  closed: {
    backgroundColor: '#f3f4f6',
    textColor: '#4b5563',
    icon: 'disconnected',
    message: 'Connection closed',
    showRetry: true,
  },
  failed: {
    backgroundColor: '#fee2e2',
    textColor: '#991b1b',
    icon: 'error',
    message: 'Connection failed',
    showRetry: true,
  },
};

export function ConnectionBanner({ state, onRetry }: ConnectionBannerProps) {
  const config = stateConfig[state];

  // Only show banner for failed connection states
  const failedStates: ConnectionState[] = ['disconnected', 'suspended', 'closed', 'failed'];
  if (!failedStates.includes(state)) {
    return null;
  }

  const renderIcon = () => {
    switch (config.icon) {
      case 'connecting':
        return <ActivityIndicator size="small" color={config.textColor} />;
      case 'disconnected':
        return <WifiOff size={16} color={config.textColor} />;
      case 'error':
        return <WifiOff size={16} color={config.textColor} />;
      default:
        return null;
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: config.backgroundColor }]}>
      <View style={styles.content}>
        {renderIcon()}
        <Text style={[styles.text, { color: config.textColor }]}>
          {config.message}
        </Text>
      </View>
      {config.showRetry && onRetry && (
        <Pressable onPress={onRetry} style={styles.retryButton}>
          <RefreshCw size={14} color={config.textColor} />
          <Text style={[styles.retryText, { color: config.textColor }]}>
            Retry
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  text: {
    fontSize: 13,
    fontWeight: '500',
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  retryText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
