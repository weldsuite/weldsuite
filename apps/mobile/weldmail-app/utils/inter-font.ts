import { Text as RNText, type TextStyle, StyleSheet, Platform } from 'react-native';

const KEEP_FAMILIES = new Set(['Menlo', 'monospace', 'Courier', 'Courier New']);

const WEIGHT_TO_INTER: Record<string, string> = {
  '100': 'Inter_100Thin',
  '200': 'Inter_200ExtraLight',
  '300': 'Inter_300Light',
  '400': 'Inter_400Regular',
  '500': 'Inter_500Medium',
  '600': 'Inter_600SemiBold',
  '700': 'Inter_700Bold',
  '800': 'Inter_800ExtraBold',
  '900': 'Inter_900Black',
  normal: 'Inter_400Regular',
  bold: 'Inter_700Bold',
};

function pickInter(weight?: TextStyle['fontWeight']): string {
  if (!weight) return 'Inter_400Regular';
  return WEIGHT_TO_INTER[String(weight)] ?? 'Inter_400Regular';
}

// Patch the global <Text> render to map fontWeight → matching Inter family.
// Preserves Menlo/monospace styles, and any explicit non-Inter fontFamily the caller set.
export function applyInterAsDefaultFont() {
  const Any = RNText as unknown as {
    render?: (...args: unknown[]) => unknown;
    defaultProps?: { style?: TextStyle | TextStyle[] };
  };

  if ((Any as { __interPatched?: boolean }).__interPatched) return;

  const originalRender = Any.render;
  if (typeof originalRender !== 'function') {
    // Fallback: just set defaultProps with the regular variant.
    Any.defaultProps = Any.defaultProps || {};
    Any.defaultProps.style = [
      { fontFamily: 'Inter_400Regular' },
      Any.defaultProps.style as TextStyle | undefined,
    ].filter(Boolean) as TextStyle[];
    (Any as { __interPatched?: boolean }).__interPatched = true;
    return;
  }

  Any.render = function patchedRender(...args: unknown[]) {
    const element = originalRender.apply(this, args) as {
      props?: { style?: unknown };
      type?: unknown;
    } | null;
    if (!element || !element.props) return element;

    const flat = StyleSheet.flatten(element.props.style as TextStyle) || {};
    const explicitFamily = flat.fontFamily;
    if (explicitFamily && KEEP_FAMILIES.has(String(explicitFamily))) {
      return element;
    }
    // Caller already chose a specific Inter variant — respect it.
    if (typeof explicitFamily === 'string' && explicitFamily.startsWith('Inter_')) {
      return element;
    }

    const family = pickInter(flat.fontWeight);
    // On iOS, RN can still try to synthesize bold/italic from the chosen variant;
    // we strip fontWeight so the Inter file's own weight is what shows.
    const overrides: TextStyle = Platform.OS === 'ios'
      ? { fontFamily: family, fontWeight: 'normal' }
      : { fontFamily: family };

    return {
      ...element,
      props: {
        ...(element.props as object),
        style: [element.props.style, overrides],
      },
    };
  };

  (Any as { __interPatched?: boolean }).__interPatched = true;
}
