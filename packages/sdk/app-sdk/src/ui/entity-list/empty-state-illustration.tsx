import type { ReactNode } from 'react';
import { useId } from 'react';

export interface EmptyStateIllustrationProps {
  children: ReactNode;
  width?: number;
  height?: number;
}

export function EmptyStateIllustration({
  children,
  width = 240,
  height = 170,
}: EmptyStateIllustrationProps) {
  const patternId = useId();
  const maskId = `${patternId}-mask`;

  return (
    <div className="wui-elist-empty-illustration">
      <div className="wui-elist-empty-illustration__frame" style={{ width, height }}>
        <svg
          className="wui-elist-empty-illustration__svg"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden
        >
          <defs>
            <pattern id={patternId} width="28" height="28" patternUnits="userSpaceOnUse">
              <path
                d="M 28 0 L 0 0 0 28"
                fill="none"
                stroke="currentColor"
                strokeWidth="0.5"
                strokeDasharray="3 3"
              />
            </pattern>
            <radialGradient id={maskId} cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
              <stop offset="0%" stopColor="white" stopOpacity="1" />
              <stop offset="70%" stopColor="white" stopOpacity="1" />
              <stop offset="100%" stopColor="white" stopOpacity="0" />
            </radialGradient>
            <mask id={`${maskId}-m`}>
              <rect width="100%" height="100%" fill={`url(#${maskId})`} />
            </mask>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${patternId})`} mask={`url(#${maskId}-m)`} />
        </svg>
        <div className="wui-elist-empty-illustration__content">{children}</div>
      </div>
    </div>
  );
}
