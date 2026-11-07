import type { FormEvent, ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { cn } from '@/lib/utils';

interface EditorDialogProps {
  title: string;
  description?: string;
  onClose: () => void;
  /** Makes the body and footer one form (Enter submits); leave it out for an editor that saves as it goes. */
  onSubmit?: () => void;
  /** The buttons at the end of the dialog (and a status line at its start). */
  footer: ReactNode;
  /** Wider for a matrix than for a short list. */
  size?: 'lg' | 'xl';
  children: ReactNode;
}

/**
 * A dialog for a bigger editor (the communication plan, the RACI matrix): a
 * header, a body that scrolls, and a footer with the buttons. The same shell
 * as the form dialogs of Governance, with a footer of its own.
 */
export function EditorDialog({ title, description, onClose, onSubmit, footer, size = 'lg', children }: Readonly<EditorDialogProps>) {
  const content = (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-2">{children}</div>
      <div className="flex items-center justify-end gap-2 border-t px-6 py-4">{footer}</div>
    </>
  );
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className={cn('flex max-h-[90dvh] flex-col gap-0 p-0', size === 'xl' ? 'sm:max-w-5xl' : 'sm:max-w-3xl')}>
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>
        {onSubmit ? (
          <form
            noValidate
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              onSubmit();
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            {content}
          </form>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">{content}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
