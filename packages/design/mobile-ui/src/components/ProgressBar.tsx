import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii } from '../constants/theme';

export interface ProgressBarProps {
  value?: number;
  height?: number;
  trackColor?: string;
  fillColor?: string;
  indeterminate?: boolean;
  style?: StyleProp<ViewStyle>;
}

const INDETERMINATE_BAR_WIDTH = 0.35;

export function ProgressBar({
  value = 0,
  height = 6,
  trackColor,
  fillColor,
  indeterminate = false,
  style,
}: ProgressBarProps) {
  const { colors } = useTheme();
  const resolvedTrack = trackColor ?? colors.secondary;
  const resolvedFill = fillColor ?? colors.primary;

  const clamped = Math.min(1, Math.max(0, value));
  const translateX = useRef(new Animated.Value(0)).current;
  const trackWidthRef = useRef(0);

  useEffect(() => {
    if (!indeterminate) return;

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(translateX, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(translateX, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [indeterminate, translateX]);

  return (
    <View
      style={[
        styles.track,
        {
          height,
          backgroundColor: resolvedTrack,
          borderRadius: Radii.full,
        },
        style,
      ]}
      onLayout={(e) => {
        trackWidthRef.current = e.nativeEvent.layout.width;
      }}
    >
      {indeterminate ? (
        <Animated.View
          style={[
            styles.fill,
            {
              backgroundColor: resolvedFill,
              borderRadius: Radii.full,
              width: `${INDETERMINATE_BAR_WIDTH * 100}%`,
              transform: [
                {
                  translateX: translateX.interpolate({
                    inputRange: [0, 1],
                    outputRange: [
                      -(INDETERMINATE_BAR_WIDTH * 300),
                      300,
                    ],
                  }),
                },
              ],
            },
          ]}
        />
      ) : (
        <View
          style={[
            styles.fill,
            {
              backgroundColor: resolvedFill,
              borderRadius: Radii.full,
              width: `${clamped * 100}%`,
            },
          ]}
        />
      )}
    </View>
  );
}

export default ProgressBar;

const styles = StyleSheet.create({
  track: {
    width: '100%',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
  },
});
