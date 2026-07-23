/**
 * shadcn-style spinner: a continuously-rotating circular loader icon
 * (lucide `LoaderCircle` + a linear spin), mirroring shadcn/ui's
 * `<Spinner>` / `<Loader2 className="animate-spin" />`.
 */
import { useEffect } from 'react';
import { LoaderCircle } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { useTheme } from '@/contexts/ThemeContext';

export function Spinner({ size = 22, color }: { size?: number; color?: string }) {
  const { colors } = useTheme();
  const rotation = useSharedValue(0);

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, { duration: 750, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(rotation);
  }, [rotation]);

  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));

  return (
    <Animated.View style={style}>
      <LoaderCircle size={size} color={color ?? colors.textSecondary} strokeWidth={2.25} />
    </Animated.View>
  );
}

export default Spinner;
