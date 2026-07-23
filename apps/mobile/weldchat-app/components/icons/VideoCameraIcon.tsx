import Svg, { Path } from 'react-native-svg';

interface VideoCameraIconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
  /** Fill color for the camera body (defaults to no fill = outline). */
  fill?: string;
}

/**
 * Heroicons "video-camera" (outline). Drop-in replacement for lucide's <Video>
 * — same size/color/strokeWidth props — used for the video-call action in chat.
 * Pass `fill` to render it solid (e.g. in call-event labels).
 */
export function VideoCameraIcon({
  size = 24,
  color = 'currentColor',
  strokeWidth = 1.5,
  fill = 'none',
}: VideoCameraIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
        stroke={color}
        fill={fill}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
