import React, { useEffect, useRef } from 'react';
import { StyleSheet, View, Text, Animated, Dimensions, TouchableOpacity } from 'react-native';
import { Check, X, Info, AlertTriangle } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const { width } = Dimensions.get('window');

export type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onHide: () => void;
}

export function Toast({ message, type = 'success', duration = 3000, onHide }: ToastProps) {
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(80)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        damping: 20,
        stiffness: 300,
        mass: 0.8,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }),
    ]).start();

    const timer = setTimeout(() => {
      dismiss();
    }, duration);

    return () => clearTimeout(timer);
  }, []);

  const dismiss = () => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 80,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onHide();
    });
  };

  const getIcon = () => {
    switch (type) {
      case 'success':
        return <Check size={15} color="#fff" strokeWidth={2.5} />;
      case 'error':
        return <X size={15} color="#fff" strokeWidth={2.5} />;
      case 'warning':
        return <AlertTriangle size={15} color="#fff" strokeWidth={2.5} />;
      case 'info':
      default:
        return <Info size={15} color="#fff" strokeWidth={2.5} />;
    }
  };

  const getAccentColor = () => {
    switch (type) {
      case 'success': return '#10B981';
      case 'error': return '#EF4444';
      case 'warning': return '#F59E0B';
      case 'info': default: return '#6B7280';
    }
  };

  return (
    <Animated.View
      style={[
        styles.container,
        {
          bottom: insets.bottom + 16,
          transform: [{ translateY }],
          opacity,
        },
      ]}
    >
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={dismiss}
        style={styles.toast}
      >
        <View style={[styles.icon, { backgroundColor: getAccentColor() }]}>
          {getIcon()}
        </View>
        <Text style={styles.message} numberOfLines={2}>
          {message}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 9999,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#18181B',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    maxWidth: width - 32,
    minWidth: 200,
    gap: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 8,
  },
  icon: {
    width: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
  },
  message: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: '#FAFAFA',
    lineHeight: 19,
  },
});
