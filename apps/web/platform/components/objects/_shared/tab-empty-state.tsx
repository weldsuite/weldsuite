/**
 * Empty states for the company / person object-panel tabs.
 *
 * Every tab shows the same thing when it has nothing yet: the dashed-grid
 * illustration, a title, a line of copy and (where the tab can create
 * something) the primary action — the look of the WeldFlow tasks page.
 *
 * Tabs built on `EntityList` pass an illustration as `emptyState.icon` and
 * `TAB_EMPTY_STATE_CLASS` as `emptyStateClassName`; the others render
 * `TabEmptyState`, which lays out the same block by hand.
 *
 * The block adapts to the panel's two layouts through the `group/tab-body`
 * marker the panel puts on its tab body (`tabBodyClassName`):
 *   - fullscreen: vertically centred in the page, like a module list page;
 *   - side panel: top-aligned with a smaller illustration, because the tab
 *     body there is a short scrolling box above the chat and a viewport-sized,
 *     centred block pushes the text below the fold.
 */

import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { EmptyStateIllustration } from '@/components/entity-list';

/** `contentClassName` for a panel's `EntityDetailView` — marks the tab body. */
export function tabBodyClassName(mode: 'panel' | 'fullscreen'): string {
  return mode === 'fullscreen' ? 'group/tab-body is-fullscreen' : 'group/tab-body is-panel';
}

/**
 * `emptyStateClassName` for an `EntityList` rendered inside a panel tab.
 *
 * Three heights, one per amount of chrome above the empty state, so that its
 * centre lands on the same line in every tab and the block doesn't jump when
 * switching tabs: a block that starts N px lower is 2N px shorter.
 */
export const TAB_EMPTY_STATE_CLASS =
  'min-h-0 py-8 group-[.is-fullscreen]/tab-body:min-h-[calc(100dvh-350px)] group-[.is-fullscreen]/tab-body:py-0';

/** Below a toolbar and a column-header row (tasks, calls, meetings). */
export const TAB_EMPTY_STATE_TABLE_CLASS =
  'min-h-0 py-8 group-[.is-fullscreen]/tab-body:min-h-[calc(100dvh-396px)] group-[.is-fullscreen]/tab-body:py-0';

/** With nothing above it (activity, audit log, deals). */
const TAB_EMPTY_STATE_BARE_CLASS =
  'min-h-0 py-8 group-[.is-fullscreen]/tab-body:min-h-[calc(100dvh-220px)] group-[.is-fullscreen]/tab-body:py-0';

/** The dashed-grid backdrop around a tab's drawing; smaller in the side panel. */
export function TabEmptyIllustration({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="group-[.is-panel]/tab-body:[zoom:0.75]">
      <EmptyStateIllustration>{children}</EmptyStateIllustration>
    </div>
  );
}

interface TabEmptyStateProps {
  illustration: ReactNode;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** The tab renders nothing (no toolbar / header row) above the empty state. */
  bare?: boolean;
}

/** The empty-state block for tabs that don't render through `EntityList`. */
export function TabEmptyState({
  illustration,
  title,
  description,
  action,
  bare,
}: Readonly<TabEmptyStateProps>) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center px-6',
        bare ? TAB_EMPTY_STATE_BARE_CLASS : TAB_EMPTY_STATE_CLASS,
      )}
    >
      {illustration}
      <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{title}</h3>
      <p className="text-sm text-muted-foreground mb-5 max-w-[320px] leading-relaxed">{description}</p>
      {action && (
        <Button
          size="sm"
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={action.onClick}
          disabled={action.disabled}
        >
          <Plus className="h-4 w-4 mr-0.5" />
          <span>{action.label}</span>
        </Button>
      )}
    </div>
  );
}

// ─── Drawings ──────────────────────────────────────────────────────────────

const TILT = { transform: 'perspective(600px) rotateY(-6deg) rotateX(4deg)' };

/** Activity — a timeline with three entries. */
export function ActivityIllustration() {
  return (
    <TabEmptyIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={TILT}>
        {/* Timeline rail */}
        <path d="M30 30V92" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" strokeDasharray="3 3" />
        {/* Entry 1 */}
        <circle cx="30" cy="34" r="6" className="fill-background stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <circle cx="30" cy="34" r="2" className="fill-gray-300 dark:fill-white/25" />
        <rect x="44" y="22" width="56" height="24" rx="5" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="51" y="30" width="30" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.7" />
        <rect x="51" y="36" width="20" height="2" rx="1" className="fill-gray-200 dark:fill-white/10" opacity="0.6" />
        {/* Entry 2 */}
        <circle cx="30" cy="62" r="6" className="fill-background stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <circle cx="30" cy="62" r="2" className="fill-gray-200 dark:fill-white/20" />
        <rect x="44" y="50" width="56" height="24" rx="5" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="51" y="58" width="36" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.6" />
        <rect x="51" y="64" width="24" height="2" rx="1" className="fill-gray-200 dark:fill-white/10" opacity="0.5" />
        {/* Entry 3 */}
        <circle cx="30" cy="90" r="6" className="fill-background stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="44" y="78" width="56" height="24" rx="5" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" opacity="0.7" />
        <rect x="51" y="86" width="26" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.4" />
        <rect x="51" y="92" width="16" height="2" rx="1" className="fill-gray-200 dark:fill-white/10" opacity="0.3" />
      </svg>
    </TabEmptyIllustration>
  );
}

/** People — two stacked contact cards. */
export function PeopleIllustration() {
  return (
    <TabEmptyIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={TILT}>
        {/* Back card */}
        <rect x="30" y="24" width="72" height="44" rx="6" className="fill-gray-50/60 dark:fill-white/[0.02] stroke-gray-200 dark:stroke-white/10" strokeWidth="1" />
        {/* Front card */}
        <rect x="18" y="40" width="84" height="56" rx="6" className="fill-background stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        {/* Avatar */}
        <rect x="28" y="50" width="26" height="26" rx="7" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <circle cx="41" cy="60" r="4" className="fill-gray-200 dark:fill-white/20" />
        <path d="M33.5 73C33.5 69 36.9 66.5 41 66.5C45.1 66.5 48.5 69 48.5 73" className="stroke-gray-200 dark:stroke-white/20" strokeWidth="1.5" strokeLinecap="round" />
        {/* Name + role */}
        <rect x="62" y="55" width="30" height="3.5" rx="1.75" className="fill-gray-200 dark:fill-white/15" opacity="0.7" />
        <rect x="62" y="63" width="22" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-white/10" opacity="0.6" />
        {/* Contact line */}
        <rect x="28" y="84" width="46" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-white/10" opacity="0.5" />
      </svg>
    </TabEmptyIllustration>
  );
}

/** Companies — an office block with a lower wing. */
export function CompaniesIllustration() {
  return (
    <TabEmptyIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Lower wing */}
        <path d="M70 52H90C92.2 52 94 53.8 94 56V96H70V52Z" className="fill-gray-50/60 dark:fill-white/[0.02] stroke-gray-200 dark:stroke-white/10" strokeWidth="1" />
        <rect x="78" y="62" width="8" height="7" rx="2" className="fill-gray-200 dark:fill-white/10" opacity="0.6" />
        <rect x="78" y="76" width="8" height="7" rx="2" className="fill-gray-200 dark:fill-white/10" opacity="0.4" />
        {/* Tower */}
        <path d="M30 28C30 25.8 31.8 24 34 24H66C68.2 24 70 25.8 70 28V96H30V28Z" className="fill-background stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        {/* Windows */}
        <rect x="38" y="33" width="9" height="8" rx="2" className="fill-gray-200 dark:fill-white/15" opacity="0.7" />
        <rect x="53" y="33" width="9" height="8" rx="2" className="fill-gray-200 dark:fill-white/15" opacity="0.5" />
        <rect x="38" y="48" width="9" height="8" rx="2" className="fill-gray-200 dark:fill-white/15" opacity="0.5" />
        <rect x="53" y="48" width="9" height="8" rx="2" className="fill-gray-200 dark:fill-white/15" opacity="0.7" />
        <rect x="38" y="63" width="9" height="8" rx="2" className="fill-gray-200 dark:fill-white/15" opacity="0.6" />
        <rect x="53" y="63" width="9" height="8" rx="2" className="fill-gray-200 dark:fill-white/15" opacity="0.4" />
        {/* Door */}
        <path d="M44 96V84C44 82.3 45.3 81 47 81H53C54.7 81 56 82.3 56 84V96" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        {/* Ground */}
        <path d="M20 96H100" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" strokeLinecap="round" />
      </svg>
    </TabEmptyIllustration>
  );
}

/** Emails — a closed envelope. */
export function EmailsIllustration() {
  return (
    <TabEmptyIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Envelope body */}
        <rect x="20" y="35" width="80" height="55" rx="4" className="fill-white dark:fill-white/[0.03]" />
        <rect x="20" y="35" width="80" height="55" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        {/* Bottom V fold lines */}
        <path d="M20 90L52 65" className="stroke-gray-100 dark:stroke-white/10" strokeWidth="1" />
        <path d="M100 90L68 65" className="stroke-gray-100 dark:stroke-white/10" strokeWidth="1" />
        {/* Flap */}
        <path d="M20.5 38C20.5 36.3 21.8 35 23.5 35H96.5C98.2 35 99.5 36.3 99.5 38L60 64Z" className="fill-gray-50 dark:fill-white/[0.06]" />
        <path d="M20 35L60 64L100 35" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" fill="none" />
      </svg>
    </TabEmptyIllustration>
  );
}

/** Deals — a three-column deal board. */
export function DealsIllustration() {
  return (
    <TabEmptyIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={TILT}>
        {/* Column 1 */}
        <rect x="14" y="24" width="28" height="74" rx="6" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="20" y="31" width="12" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" />
        <rect x="19" y="40" width="18" height="14" rx="3" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" />
        <rect x="19" y="58" width="18" height="14" rx="3" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" />
        <rect x="19" y="76" width="18" height="14" rx="3" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" opacity="0.6" />
        {/* Column 2 */}
        <rect x="46" y="24" width="28" height="74" rx="6" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="52" y="31" width="14" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" />
        <rect x="51" y="40" width="18" height="14" rx="3" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" />
        <rect x="51" y="58" width="18" height="14" rx="3" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" opacity="0.6" />
        {/* Column 3 */}
        <rect x="78" y="24" width="28" height="74" rx="6" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="84" y="31" width="10" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" />
        <rect x="83" y="40" width="18" height="14" rx="3" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-200 dark:stroke-white/15" strokeWidth="0.8" opacity="0.6" />
      </svg>
    </TabEmptyIllustration>
  );
}

/** Notes — a sheet with a folded corner. */
export function NotesIllustration() {
  return (
    <TabEmptyIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={TILT}>
        {/* Sheet */}
        <path d="M32 20H88C91.3 20 94 22.7 94 26V78L74 98H32C28.7 98 26 95.3 26 92V26C26 22.7 28.7 20 32 20Z" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        {/* Folded corner */}
        <path d="M94 78H80C76.7 78 74 80.7 74 84V98L94 78Z" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" strokeLinejoin="round" />
        {/* Title + lines */}
        <rect x="36" y="32" width="28" height="4" rx="2" className="fill-gray-200 dark:fill-white/20" />
        <rect x="36" y="44" width="48" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.6" />
        <rect x="36" y="52" width="42" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.5" />
        <rect x="36" y="60" width="46" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.4" />
        <rect x="36" y="68" width="26" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.3" />
      </svg>
    </TabEmptyIllustration>
  );
}

/** Files — a folder. */
export function FilesIllustration() {
  return (
    <TabEmptyIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Folder fill */}
        <path d="M20 30C20 27.8 21.8 26 24 26H48L54 34H96C98.2 34 100 35.8 100 38V92C100 94.2 98.2 96 96 96H24C21.8 96 20 94.2 20 92V30Z" className="fill-white dark:fill-white/[0.03]" />
        {/* Tab highlight */}
        <path d="M20 30C20 27.8 21.8 26 24 26H48L54 34H20V30Z" className="fill-gray-50 dark:fill-white/[0.06]" />
        {/* Folder border (on top) */}
        <path d="M20 30C20 27.8 21.8 26 24 26H48L54 34H96C98.2 34 100 35.8 100 38V92C100 94.2 98.2 96 96 96H24C21.8 96 20 94.2 20 92V30Z" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
      </svg>
    </TabEmptyIllustration>
  );
}

/** Audit log — a change list with a clock. */
export function AuditIllustration() {
  return (
    <TabEmptyIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={TILT}>
        {/* Log sheet */}
        <rect x="22" y="20" width="64" height="78" rx="6" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        {/* Rows */}
        <circle cx="33" cy="35" r="2.5" className="fill-gray-300 dark:fill-white/25" />
        <rect x="41" y="33.5" width="34" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.7" />
        <circle cx="33" cy="49" r="2.5" className="fill-gray-200 dark:fill-white/20" />
        <rect x="41" y="47.5" width="26" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.6" />
        <circle cx="33" cy="63" r="2.5" className="fill-gray-200 dark:fill-white/20" />
        <rect x="41" y="61.5" width="30" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.5" />
        <circle cx="33" cy="77" r="2.5" className="fill-gray-200 dark:fill-white/15" />
        <rect x="41" y="75.5" width="18" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.4" />
        {/* Clock */}
        <circle cx="84" cy="84" r="17" className="fill-background stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <path d="M84 74V84L90.5 88" className="stroke-gray-300 dark:stroke-white/25" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </TabEmptyIllustration>
  );
}
