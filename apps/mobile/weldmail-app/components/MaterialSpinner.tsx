import React, { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface MaterialSpinnerProps {
  size?: number;
  strokeWidth?: number;
  color?: string;
  /** Indeterminate Material spin while a refresh is in flight. */
  spinning: boolean;
  /** Live scroll offset (negative while pulling) — drives the determinate arc. */
  pullValue?: Animated.Value;
  /** Pull distance (px) at which the determinate arc is full. */
  trigger?: number;
}

/**
 * Gmail's pull-to-refresh spinner: a Material circular progress indicator.
 * - While pulling, the arc draws on proportionally to the pull distance and rotates.
 * - Once refreshing, it becomes indeterminate — the arc grows/shrinks as the whole
 *   ring rotates, exactly like Material's CircularProgressIndicator.
 */
export default function MaterialSpinner({
  size = 22,
  strokeWidth = 2.6,
  color = '#4285F4',
  spinning,
  pullValue,
  trigger = 80,
}: MaterialSpinnerProps) {
  const r = (size - strokeWidth) / 2;
  const C = 2 * Math.PI * r;

  const rotate = useRef(new Animated.Value(0)).current;
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!spinning) return;
    rotate.setValue(0);
    sweep.setValue(0);
    // Rotation and arc-sweep run at different periods so the motion never
    // looks like it simply repeats — the Material spinner signature.
    const rot = Animated.loop(
      Animated.timing(rotate, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: false,
      })
    );
    const sw = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(sweep, {
          toValue: 0,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
      ])
    );
    rot.start();
    sw.start();
    return () => {
      rot.stop();
      sw.stop();
    };
  }, [spinning, rotate, sweep]);

  // Determinate progress (0 → 1) derived from the pull distance.
  const progress = pullValue
    ? pullValue.interpolate({
        inputRange: [-trigger, 0],
        outputRange: [1, 0],
        extrapolate: 'clamp',
      })
    : new Animated.Value(0);

  // strokeDashoffset = C * (1 - visibleFraction). Base -90° starts the arc at 12 o'clock.
  const groupRotate = spinning
    ? rotate.interpolate({ inputRange: [0, 1], outputRange: ['-90deg', '270deg'] })
    : progress.interpolate({ inputRange: [0, 1], outputRange: ['-90deg', '180deg'] });

  const dashoffset = spinning
    ? sweep.interpolate({ inputRange: [0, 1], outputRange: [C * 0.92, C * 0.2] })
    : progress.interpolate({ inputRange: [0, 1], outputRange: [C, C * 0.2] });

  return (
    <Animated.View
      style={{ width: size, height: size, transform: [{ rotate: groupRotate }] }}
    >
      <Svg width={size} height={size}>
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={dashoffset}
        />
      </Svg>
    </Animated.View>
  );
}
