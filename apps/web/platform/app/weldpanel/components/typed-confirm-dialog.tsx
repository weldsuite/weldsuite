/**
 * A destructive confirm that asks for the name of the thing being destroyed,
 * so the wrong project is never deleted by a reflex click. The shared
 * `ConfirmDialog` has no input; the pattern is the one Settings uses to
 * delete a workspace.
 */

import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';

interface TypedConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** The text to type, e.g. the project name. */
  expected: string;
  /** The prompt above the input ("Type X to confirm"). */
  prompt: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Runs when the name matches and the button is pressed. Close the dialog from here on success. */
  onConfirm: () => Promise<void>;
}

export function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  expected,
  prompt,
  confirmLabel,
  cancelLabel,
  onConfirm,
}: Readonly<TypedConfirmDialogProps>) {
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);

  // Every opening starts empty.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const matches = typed.trim() === expected;

  async function confirm() {
    if (!matches) return;
    setPending(true);
    try {
      await onConfirm();
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={inputId}>{prompt}</Label>
            <Input id={inputId} value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={expected} autoComplete="off" disabled={pending} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button type="submit" variant="destructive" disabled={!matches || pending}>
              {pending && <Loader2 className="animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
