/**
 * The app's type, after Attio's: Inter, medium (500) wherever a style names no
 * weight, tracked a little tight (-0.02em from 13 to 15pt, -0.01em from 16pt,
 * none at 12pt and under) unless a style sets its own, with Inter's ss03 on,
 * in Attio's text colours.
 *
 * React Native has no default font, so this swaps the `Text` and `TextInput`
 * that `react-native` hands out for ones that fill all of that in. Every
 * screen gets them without importing anything else, the shared mobile-ui
 * components included: whose black and grey text (the shared theme's, which
 * other apps keep) is drawn in Attio's colours here. Imported first thing in
 * the root layout, which also loads the faces before anything renders.
 *
 * The weight picks one of Inter's static faces (Inter_600SemiBold, ...) and the
 * style's weight is cleared, so the system never fakes a bold on top of one.
 */

import { createElement, useContext, type ComponentProps, type Context } from 'react';
import {
  StyleSheet,
  type StyleProp,
  type Text as RNText,
  type TextInput as RNTextInput,
  type TextStyle,
} from 'react-native';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';

/** The faces to load (useFonts), by the family name a style asks for. */
export const APP_FONTS = { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold };
type Face = keyof typeof APP_FONTS;

/** Attio's text colours. */
export const ATTIO_TEXT = {
  ink: '#1C1D1F',
  secondary: '#6F7988',
  tertiary: '#8F99A8',
  inkDark: '#EFF3F4',
  secondaryDark: '#97A0AF',
} as const;

const FACES: Record<string, Face> = {
  '100': 'Inter_400Regular',
  '200': 'Inter_400Regular',
  '300': 'Inter_400Regular',
  '400': 'Inter_400Regular',
  normal: 'Inter_400Regular',
  '500': 'Inter_500Medium',
  '600': 'Inter_600SemiBold',
  '700': 'Inter_700Bold',
  bold: 'Inter_700Bold',
  '800': 'Inter_800ExtraBold',
  '900': 'Inter_800ExtraBold',
};
const DEFAULT_WEIGHT = '500';

/** The shared theme's text colours, and the Attio colour each is drawn in. */
const RECOLOR: Record<string, string> = {
  '#000': ATTIO_TEXT.ink,
  '#000000': ATTIO_TEXT.ink,
  black: ATTIO_TEXT.ink,
  '#666': ATTIO_TEXT.secondary,
  '#666666': ATTIO_TEXT.secondary,
  '#6b7280': ATTIO_TEXT.secondary,
  '#8e8e93': ATTIO_TEXT.tertiary,
  '#9ca3af': ATTIO_TEXT.secondaryDark,
};

const recolor = (color: unknown) => (typeof color === 'string' ? RECOLOR[color.toLowerCase()] : undefined);

/** Attio's tracking for a size, in points. */
export function tracking(size: number): number {
  if (size <= 12) return 0;
  return size < 16 ? -0.02 * size : -0.01 * size;
}

/**
 * The style with Inter's face for its weight, Attio's tracking and colour, and
 * ss03. Text inside other text (`nested`) keeps what it does not set itself,
 * so a bold word in a line or a line's size passes down as it would.
 */
function attio(style: StyleProp<TextStyle>, nested: boolean): StyleProp<TextStyle> {
  const flat = StyleSheet.flatten(style) ?? {};
  // A font of its own (the error screen's monospace).
  if (flat.fontFamily) return style;
  const extra: TextStyle = {};
  if (flat.fontWeight != null || !nested) {
    extra.fontFamily = FACES[String(flat.fontWeight ?? DEFAULT_WEIGHT)] ?? FACES[DEFAULT_WEIGHT];
    extra.fontWeight = 'normal';
  }
  if (flat.letterSpacing == null && (flat.fontSize != null || !nested)) extra.letterSpacing = tracking(flat.fontSize ?? 14);
  if (!flat.fontVariant?.includes('stylistic-three')) extra.fontVariant = [...(flat.fontVariant ?? []), 'stylistic-three'];
  const color = recolor(flat.color);
  if (color) extra.color = color;
  return [style, extra];
}

type ReactNativeExports = { Text: typeof RNText; TextInput: typeof RNTextInput; unstable_TextAncestorContext: Context<boolean> };

/** Set on react-native once swapped, so a hot reload of this file does not wrap the wrappers. */
const INSTALLED = Symbol.for('weldhr.app-font');

function install() {
  // The module's own exports: `import { Text } from 'react-native'` reads
  // `Text` off this object each time it renders one, so a new getter reaches
  // every importer at once.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the exports object itself, see above
  const ReactNative = require('react-native') as ReactNativeExports;
  if (Reflect.get(ReactNative, INSTALLED)) return;
  Reflect.set(ReactNative, INSTALLED, true);
  const BaseText = ReactNative.Text;
  const BaseTextInput = ReactNative.TextInput;
  const TextAncestor = ReactNative.unstable_TextAncestorContext;

  function AppText(props: ComponentProps<typeof RNText>) {
    const nested = useContext(TextAncestor);
    return createElement(BaseText, { ...props, style: attio(props.style, nested) });
  }
  AppText.displayName = 'Text';

  function AppTextInput(props: ComponentProps<typeof RNTextInput>) {
    return createElement(BaseTextInput, {
      ...props,
      style: attio(props.style, false),
      placeholderTextColor: recolor(props.placeholderTextColor) ?? props.placeholderTextColor,
    });
  }
  // TextInput.State and the rest, which keyboard libraries read.
  Object.assign(AppTextInput, BaseTextInput);
  AppTextInput.displayName = 'TextInput';

  Object.defineProperty(ReactNative, 'Text', { configurable: true, enumerable: true, get: () => AppText });
  Object.defineProperty(ReactNative, 'TextInput', { configurable: true, enumerable: true, get: () => AppTextInput });
}

install();
