/**
 * The drawings of the decision log's empty states, in the dashed-grid
 * illustration of the WeldFlow tasks page.
 */

import { EmptyStateIllustration } from '@/components/entity-list';
import { TabEmptyIllustration } from '@/components/objects/_shared/tab-empty-state';

const TILT = { transform: 'perspective(600px) rotateY(-6deg) rotateX(4deg)' };

/** The log has no decisions yet: a sheet with two options, one taken. */
export function DecisionsIllustration() {
  return (
    <EmptyStateIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={TILT}>
        {/* Sheet */}
        <rect x="20" y="14" width="80" height="92" rx="6" className="fill-white dark:fill-white/[0.03]" />
        <rect x="20" y="14" width="80" height="92" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="30" y="26" width="36" height="4" rx="2" className="fill-gray-200 dark:fill-white/20" />
        {/* Option taken */}
        <rect x="28" y="42" width="64" height="20" rx="4" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" />
        <circle cx="39" cy="52" r="5" className="stroke-gray-300 dark:stroke-white/25" strokeWidth="1.2" fill="none" />
        <path d="M36.6 52.2L38.5 54L41.7 50.3" className="stroke-gray-400 dark:stroke-white/35" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="50" y="48.5" width="30" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.7" />
        <rect x="50" y="54.5" width="20" height="2" rx="1" className="fill-gray-200 dark:fill-white/10" opacity="0.6" />
        {/* Option left */}
        <rect x="28" y="68" width="64" height="20" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" opacity="0.7" />
        <circle cx="39" cy="78" r="5" className="stroke-gray-200 dark:stroke-white/20" strokeWidth="1.2" fill="none" />
        <rect x="50" y="74.5" width="26" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.5" />
        <rect x="50" y="80.5" width="16" height="2" rx="1" className="fill-gray-200 dark:fill-white/10" opacity="0.4" />
        {/* Consequence */}
        <rect x="30" y="95" width="30" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.4" />
      </svg>
    </EmptyStateIllustration>
  );
}

/** A decision with nothing linked: two records and the line between them. */
export function LinkedIllustration() {
  return (
    <TabEmptyIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={TILT}>
        {/* First record */}
        <rect x="14" y="24" width="46" height="32" rx="6" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="22" y="33" width="26" height="3.5" rx="1.75" className="fill-gray-200 dark:fill-white/20" />
        <rect x="22" y="41" width="18" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-white/10" opacity="0.6" />
        {/* Second record */}
        <rect x="60" y="66" width="46" height="32" rx="6" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="68" y="75" width="26" height="3.5" rx="1.75" className="fill-gray-200 dark:fill-white/20" />
        <rect x="68" y="83" width="18" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-white/10" opacity="0.6" />
        {/* The link */}
        <path d="M60 40H76C79.3 40 82 42.7 82 46V66" className="stroke-gray-300 dark:stroke-white/25" strokeWidth="1.2" strokeDasharray="3 3" strokeLinecap="round" />
        <circle cx="60" cy="40" r="2.5" className="fill-background stroke-gray-300 dark:stroke-white/25" strokeWidth="1.2" />
        <circle cx="82" cy="66" r="2.5" className="fill-background stroke-gray-300 dark:stroke-white/25" strokeWidth="1.2" />
      </svg>
    </TabEmptyIllustration>
  );
}
