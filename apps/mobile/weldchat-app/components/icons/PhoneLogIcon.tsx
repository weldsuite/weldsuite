import Svg, { Path } from 'react-native-svg';

interface PhoneLogIconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

/**
 * Lucide "phone-log" (lucide-static 1.61, ISC), which the app's
 * lucide-react-native version does not ship yet. Same props as a lucide icon.
 */
export function PhoneLogIcon({ size = 24, color = 'currentColor', strokeWidth = 2 }: Readonly<PhoneLogIconProps>) {
  const stroke = { stroke: color, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M13.832 16.568a1 1 0 001.213-.303l.355-.465A2 2 0 0117 15h3a2 2 0 012 2v3a2 2 0 01-2 2A18 18 0 012 4a2 2 0 012-2h3a2 2 0 012 2v3a2 2 0 01-.8 1.6l-.468.351a1 1 0 00-.292 1.233 14 14 0 006.392 6.384"
        {...stroke}
      />
      <Path d="M14.396 4.171h7.171" {...stroke} />
      <Path d="M17.343 8.17h4.224" {...stroke} />
    </Svg>
  );
}
