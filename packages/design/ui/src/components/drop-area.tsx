import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { useDropzone, type DropzoneOptions } from 'react-dropzone';

import { cn } from '@weldsuite/ui/lib/utils';

/**
 * A region that takes files dragged in from outside the browser, such as a
 * conversation in a chat app. Unlike `Dropzone` (a button you click or drop
 * onto), the region stays fully usable: nothing changes until files are dragged
 * over it, when `DropAreaOverlay` covers it WhatsApp-style: a dashed
 * rounded border just inside its edges with the text centred in it.
 *
 * Dragging is a pointer-only shortcut, so the overlay is hidden from assistive
 * technology: keep another way to add files (an attach button) next to it.
 *
 *   <DropArea onDrop={(files) => attach(files)}>
 *     …the conversation…
 *     <DropAreaOverlay title="Upload to #general" />
 *   </DropArea>
 */

const DropAreaContext = createContext<{ isDragActive: boolean }>({ isDragActive: false });

export interface DropAreaProps
  extends Omit<ComponentProps<'div'>, 'onDrop' | 'onDragEnter' | 'onDragLeave' | 'onDragOver'> {
  /** The files dropped (those `accept`, `maxSize` and the like let through). */
  onDrop: (files: File[]) => void;
  /** react-dropzone options for which files count, e.g. `accept`, `maxSize`, `multiple`. */
  options?: Omit<DropzoneOptions, 'onDrop' | 'noClick' | 'noKeyboard'>;
}

export function DropArea({ onDrop, options, className, children, ...props }: Readonly<DropAreaProps>) {
  const { getRootProps, isDragActive } = useDropzone({
    multiple: true,
    ...options,
    // The region is the page's own content: clicks and keys stay with it.
    noClick: true,
    noKeyboard: true,
    onDrop: (accepted) => {
      if (accepted.length > 0) onDrop(accepted);
    },
  });

  return (
    <DropAreaContext.Provider value={{ isDragActive }}>
      <div
        data-slot="drop-area"
        data-drag-active={isDragActive || undefined}
        {...getRootProps({ className: cn('relative', className), ...props })}
      >
        {children}
      </div>
    </DropAreaContext.Provider>
  );
}

export interface DropAreaOverlayProps {
  /** What dropping does, e.g. "Upload to #general". */
  title: ReactNode;
  /** An optional quieter line under the title. */
  description?: ReactNode;
  /** An optional icon above the title. */
  icon?: ReactNode;
  className?: string;
}

/**
 * Covers its `DropArea` while files are dragged over it, as WhatsApp does: the
 * area blurs behind a frosted panel with a dashed rounded border just inside
 * its edges and the text centred in it.
 */
export function DropAreaOverlay({ title, description, icon, className }: Readonly<DropAreaOverlayProps>) {
  const { isDragActive } = useContext(DropAreaContext);
  if (!isDragActive) return null;

  return (
    <div
      data-slot="drop-area-overlay"
      aria-hidden
      className={cn(
        // Frosted: what is behind stays visible but blurred, so the centred text reads clearly.
        'pointer-events-none absolute inset-0 z-40 bg-background/60 p-4 backdrop-blur-md',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150',
        className,
      )}
    >
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-muted-foreground/35 px-6 text-center">
        {icon}
        <p className="text-lg font-medium text-muted-foreground [overflow-wrap:anywhere]">{title}</p>
        {description && <p className="text-sm text-muted-foreground/80">{description}</p>}
      </div>
    </div>
  );
}
