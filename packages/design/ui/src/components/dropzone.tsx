import { createContext, useContext, type ReactNode } from 'react';
import { useDropzone, type DropzoneOptions, type DropzoneState } from 'react-dropzone';
import { UploadIcon } from 'lucide-react';

import { cn } from '@weldsuite/ui/lib/utils';
import { Button } from '@weldsuite/ui/components/button';

interface DropzoneContextValue {
  state: DropzoneState;
  accept?: DropzoneOptions['accept'];
  maxFiles?: number;
  maxSize?: number;
  src?: File[];
}

const DropzoneContext = createContext<DropzoneContextValue | null>(null);

function useDropzoneContext() {
  const ctx = useContext(DropzoneContext);
  if (!ctx) throw new Error('Dropzone subcomponents must be used within <Dropzone>');
  return ctx;
}

export interface DropzoneProps extends Omit<DropzoneOptions, 'onDrop'> {
  src?: File[];
  className?: string;
  children?: ReactNode;
  onDrop?: DropzoneOptions['onDrop'];
}

export function Dropzone({
  accept,
  maxFiles,
  maxSize,
  minSize,
  multiple = true,
  disabled,
  noClick,
  noDrag,
  noDragEventsBubbling,
  noKeyboard,
  preventDropOnDocument,
  src,
  className,
  children,
  onDrop,
  ...rest
}: DropzoneProps) {
  const state = useDropzone({
    accept,
    maxFiles,
    maxSize,
    minSize,
    multiple,
    disabled,
    noClick,
    noDrag,
    noDragEventsBubbling,
    noKeyboard,
    preventDropOnDocument,
    onDrop,
    ...rest,
  });

  return (
    <DropzoneContext.Provider value={{ state, accept, maxFiles, maxSize, src }}>
      <Button
        type="button"
        variant="outline"
        {...state.getRootProps()}
        className={cn(
          'relative h-auto w-full flex-col overflow-hidden px-8 py-12 border-dashed',
          state.isDragActive && 'outline outline-1 outline-primary',
          className,
        )}
        disabled={disabled}
      >
        <input {...state.getInputProps()} />
        {children}
      </Button>
    </DropzoneContext.Provider>
  );
}

export function DropzoneEmptyState({ className }: { className?: string }) {
  const { src, accept, maxSize, maxFiles } = useDropzoneContext();

  if (src && src.length > 0) return null;

  let caption = '';
  if (accept) {
    caption += 'Accepts ';
    caption += new Intl.ListFormat('en').format(Object.keys(accept));
  }
  if (maxSize) {
    caption += ` up to ${(maxSize / 1024 / 1024).toFixed(0)} MB`;
  }
  if (maxFiles && maxFiles > 0) {
    caption += `, max ${maxFiles} file${maxFiles === 1 ? '' : 's'}`;
  }

  return (
    <div className={cn('flex flex-col items-center justify-center gap-2.5 text-center', className)}>
      <div className="flex items-center justify-center text-muted-foreground">
        <UploadIcon className="size-4" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Upload a file</p>
        <p className="text-muted-foreground text-xs">Drag and drop or click to upload</p>
        {caption && <p className="text-muted-foreground text-xs">{caption.trim()}</p>}
      </div>
    </div>
  );
}

export function DropzoneContent({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const { src } = useDropzoneContext();
  if (!src || src.length === 0) return null;
  return <div className={cn('flex flex-col items-center gap-2', className)}>{children}</div>;
}
