
import { ReactNode, useId } from 'react';

interface EmptyStateIllustrationProps {
  children: ReactNode;
  width?: number;
  height?: number;
}

export function EmptyStateIllustration({ children, width = 240, height = 170 }: EmptyStateIllustrationProps) {
  const patternId = useId();
  const maskId = `${patternId}-mask`;

  return (
    <div className="relative mb-6">
      <div className="relative" style={{ width, height }}>
        <svg className="absolute inset-0 w-full h-full" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id={patternId} width="28" height="28" patternUnits="userSpaceOnUse">
              <path d="M 28 0 L 0 0 0 28" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="3 3" className="text-gray-200 dark:text-white/[0.06]" />
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
        <div className="absolute inset-0 flex items-center justify-center">
          {children}
        </div>
      </div>
    </div>
  );
}
