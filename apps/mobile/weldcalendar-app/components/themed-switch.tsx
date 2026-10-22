/**
 * The app's on/off switch: brand track, themed knob in both states.
 * Use this instead of the bare react-native `Switch`.
 */

import React from 'react';
import { Switch, type SwitchProps } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { switchColors } from '@/lib/switch-colors';

type ThemedSwitchProps = Omit<
  SwitchProps,
  'trackColor' | 'thumbColor' | 'ios_backgroundColor'
> & { value: boolean };

export function ThemedSwitch({ value, ...rest }: Readonly<ThemedSwitchProps>) {
  const { colors } = useTheme();
  return <Switch value={value} {...switchColors(colors, value)} {...rest} />;
}
