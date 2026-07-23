/**
 * App-wide Instagram-style typography.
 *
 * Instagram's app uses "Instagram Sans" — a geometric humanist sans-serif.
 * Inter is the closest freely-licensable match, so we render EVERY <Text> and
 * <TextInput> in the app (typed text AND placeholder preview text) with the
 * Inter family that matches its `fontWeight`.
 *
 * In RN 0.81 / React 19, Text and TextInput are plain function components, so
 * the old `Text.render` monkeypatch no longer exists. Instead we wrap the
 * default export of each underlying RN module: `react-native`'s lazy index
 * getters re-read `.default` on every access, so swapping it once propagates to
 * every consumer regardless of import/interop order. Any style passed by a
 * component still wins — we only inject `fontFamily` (derived from the
 * component's own `fontWeight`) and strip the now-redundant numeric weight so
 * Android selects the correct named font file instead of synthetically bolding.
 */
import React from 'react';
import { StyleSheet } from 'react-native';

import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';

/** Font map handed to expo-font's useFonts() in the root layout. */
export const interFontMap = {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} as const;

/** Resolve a RN fontWeight to the nearest loaded Inter variant. */
function familyForWeight(weight?: string | number): string {
  const w = weight == null ? '400' : String(weight);
  switch (w) {
    case '100':
    case '200':
    case '300':
    case '400':
    case 'normal':
      return 'Inter_400Regular';
    case '500':
      return 'Inter_500Medium';
    case '600':
      return 'Inter_600SemiBold';
    case '700':
    case 'bold':
      return 'Inter_700Bold';
    case '800':
    case '900':
      return 'Inter_800ExtraBold';
    default:
      return 'Inter_400Regular';
  }
}

type AnyComponent = React.ComponentType<{ style?: unknown }> & {
  __interWrapped?: boolean;
  displayName?: string;
};

/** Build a component that renders `Original` with the Inter family injected. */
function wrapWithInter(Original: AnyComponent): AnyComponent {
  const Wrapped: AnyComponent = (props: { style?: unknown }) => {
    const flat = (StyleSheet.flatten(props.style) ?? {}) as {
      fontWeight?: string | number;
      fontFamily?: string;
    };
    // A component that explicitly set its own fontFamily (e.g. icon fonts) keeps it.
    const family = flat.fontFamily ?? familyForWeight(flat.fontWeight);
    return React.createElement(Original, {
      ...props,
      style: [{ fontFamily: family }, props.style, { fontWeight: undefined }],
    });
  };
  Wrapped.__interWrapped = true;
  Wrapped.displayName = `Inter(${Original.displayName ?? 'Component'})`;
  return Wrapped;
}

/** Swap the `.default` export of an RN component module for its Inter wrapper. */
function patchModuleDefault(mod: { default: AnyComponent } | undefined): void {
  if (!mod?.default || mod.default.__interWrapped) return;
  mod.default = wrapWithInter(mod.default);
}

/**
 * Install the Inter typography globally. Safe to call once at module load —
 * the per-module guard makes it idempotent across fast refresh.
 */
export function installInterFont(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    patchModuleDefault(require('react-native/Libraries/Text/Text'));
  } catch {
    // RN internals moved — fall back to system font rather than crashing.
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    patchModuleDefault(require('react-native/Libraries/Components/TextInput/TextInput'));
  } catch {
    // RN internals moved — fall back to system font rather than crashing.
  }
}
