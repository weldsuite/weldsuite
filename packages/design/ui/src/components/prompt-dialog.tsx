import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useUiLabels } from '@weldsuite/ui/providers/ui-labels-provider';

export interface PromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  /** The field's label. */
  label: string;
  /** What the field holds when the dialog opens. */
  defaultValue?: string;
  placeholder?: string;
  type?: 'text' | 'url';
  /** Defaults to the `save` label of `UiLabelsProvider`. */
  confirmLabel?: string;
  /** Defaults to the `cancel` label of `UiLabelsProvider`. */
  cancelLabel?: string;
  /** Lets the field be saved empty (to clear a value). Off: saving needs some text. */
  allowEmpty?: boolean;
  /** Gets the trimmed value; the dialog closes after it. */
  onConfirm: (value: string) => void | Promise<void>;
}

/**
 * Asks for one line of text (a name, a link, a description): the stand-in for
 * `window.prompt`. Enter saves, Escape cancels, and the field starts selected
 * so typing replaces what was there.
 */
export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  defaultValue = '',
  placeholder,
  type = 'text',
  confirmLabel,
  cancelLabel,
  allowEmpty = false,
  onConfirm,
}: Readonly<PromptDialogProps>) {
  const labels = useUiLabels();
  const id = React.useId();
  const [value, setValue] = React.useState(defaultValue);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (open) setValue(defaultValue);
  }, [open, defaultValue]);

  const trimmed = value.trim();
  const canSave = !pending && (allowEmpty || trimmed.length > 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setPending(true);
    try {
      await onConfirm(trimmed);
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={id}>{label}</Label>
            <Input
              id={id}
              type={type}
              value={value}
              placeholder={placeholder}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              {cancelLabel ?? labels.cancel}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {confirmLabel ?? labels.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
