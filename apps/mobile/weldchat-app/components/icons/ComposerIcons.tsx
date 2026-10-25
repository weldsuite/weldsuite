import Svg, { Path, Rect } from 'react-native-svg';

interface ComposerIconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

/*
 * The chat composer's icons, traced from the ChatGPT iOS composer so the bar
 * matches it point for point. Each is drawn on a 24×24 grid where one unit is
 * one point at the default size, so the glyph sizes below are the real ones.
 */

/** Microphone: 17 × 22 pt glyph, wider capsule and a shallow cup than lucide's. */
export function MicIcon({ size = 24, color = 'currentColor', strokeWidth = 1.9 }: Readonly<ComposerIconProps>) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={7.94} y={1.95} width={8.12} height={12.7} rx={4.06} stroke={color} strokeWidth={strokeWidth} />
      <Path
        d="M4.56 13.95A8.18 8.18 0 0 0 19.44 13.95M12 18.69V21.95"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Send arrow: 13 × 15 pt, taller than wide, inside the solid send button. */
export function SendArrowIcon({ size = 24, color = 'currentColor', strokeWidth = 2 }: Readonly<ComposerIconProps>) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 18.65V5.35M6.45 10.9 12 5.35l5.55 5.55"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * Two opposite corner brackets: pointing out to grow the text field, pointing
 * in (`collapse`) to shrink it back.
 */
export function ExpandIcon({
  size = 24,
  color = 'currentColor',
  strokeWidth = 1.75,
  collapse = false,
}: Readonly<ComposerIconProps & { collapse?: boolean }>) {
  const d = collapse
    ? 'M12.3 6.5V11.7H17.5M11.7 17.5V12.3H6.5'
    : 'M12.3 6.5H17.5V11.7M6.5 12.3V17.5H11.7';
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={d} stroke={color} strokeWidth={strokeWidth} strokeLinecap="butt" strokeLinejoin="miter" />
    </Svg>
  );
}
