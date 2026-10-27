/**
 * Empty-state drawing for the shift requests list: a roster card with a few
 * scheduled shifts and one dashed block, the shift somebody has asked for.
 * Same line-drawing style, and the same dashed-grid backdrop, as the WeldFlow
 * tasks page's clipboard.
 */

import { EmptyStateIllustration } from '@/components/entity-list';

export function ShiftRequestsEmptyIllustration() {
  return (
    <EmptyStateIllustration>
      <svg
        width="120"
        height="140"
        viewBox="0 0 120 140"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ transform: 'perspective(600px) rotateY(-6deg) rotateX(4deg)' }}
      >
        {/* Roster card */}
        <rect x="12" y="22" width="96" height="100" rx="6" className="fill-white dark:fill-white/[0.03]" />
        <rect x="12" y="22" width="96" height="100" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="12" y="22" width="96" height="14" rx="6" className="fill-gray-50/60 dark:fill-white/[0.06]" />
        {/* Day columns */}
        <rect x="46" y="27" width="10" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" />
        <rect x="64" y="27" width="10" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" />
        <rect x="82" y="27" width="10" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" />
        {/* Row 1 - scheduled */}
        <rect x="20" y="46" width="14" height="14" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" fill="none" />
        <rect x="44" y="48" width="22" height="10" rx="3" className="fill-gray-200 dark:fill-white/15" opacity="0.6" />
        <rect x="80" y="48" width="18" height="10" rx="3" className="fill-gray-200 dark:fill-white/10" opacity="0.5" />
        {/* Row 2 - scheduled */}
        <rect x="20" y="68" width="14" height="14" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" fill="none" />
        <rect x="62" y="70" width="22" height="10" rx="3" className="fill-gray-200 dark:fill-white/15" opacity="0.6" />
        {/* Row 3 - requested, not on the roster yet */}
        <rect x="20" y="90" width="14" height="14" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" fill="none" />
        <rect
          x="44"
          y="92"
          width="22"
          height="10"
          rx="3"
          className="stroke-gray-300 dark:stroke-white/25"
          strokeWidth="1"
          strokeDasharray="3 2"
          fill="none"
        />
        {/* Waiting badge */}
        <circle cx="94" cy="108" r="13" className="fill-white dark:fill-white/[0.06]" />
        <circle cx="94" cy="108" r="13" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <path d="M94 101V108L99 111" className="stroke-gray-300 dark:stroke-white/25" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </EmptyStateIllustration>
  );
}
