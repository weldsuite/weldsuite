import { cn } from '@/lib/utils';

/**
 * For rows whose cells are arbitrary caller-rendered content: lifts a cell
 * above the overlay but lets clicks on plain content fall through to it,
 * while interactive content (links, buttons, inputs) stays clickable itself.
 */
export const ROW_CELL_PASSTHROUGH =
  'relative pointer-events-none [&_:is(a,button,input,select,textarea,label,[role=checkbox],[role=menuitem],[role=combobox])]:pointer-events-auto';

interface RowOverlayButtonProps {
  /** Accessible name, e.g. the row's title. */
  label: string;
  onClick: () => void;
  onDoubleClick?: () => void;
  className?: string;
}

/**
 * Native button stretched over a clickable list row or card (the row needs
 * `relative`). It makes the row keyboard- and screen-reader-operable without
 * nesting the row's own controls inside a button: put `relative z-[1]` on
 * those controls so they stay above the overlay and keep their own clicks.
 */
export function RowOverlayButton({ label, onClick, onDoubleClick, className }: Readonly<RowOverlayButtonProps>) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        // `!absolute !z-0`: rows lift their own controls with a descendant rule
        // (`[&_:is(a,button)]:relative … z-[1]`) that also matches this button;
        // without the override it turns `relative`, collapses to 0×0 and the
        // row stops being clickable.
        '!absolute inset-0 !z-0 cursor-pointer rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        className,
      )}
    />
  );
}
