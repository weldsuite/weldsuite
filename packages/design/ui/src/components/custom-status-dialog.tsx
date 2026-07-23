"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./dialog";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";

/**
 * The current custom-status value the dialog edits. Decoupled from any
 * presence context: the consumer passes the current text/emoji in and
 * receives the edited result via `onSave` / `onClear`.
 */
export interface CustomStatusValue {
  /** Free-text status message (e.g. "In a meeting"). */
  statusText?: string;
  /** Short emoji shown alongside the message. */
  statusEmoji?: string;
}

export interface CustomStatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The current custom status. Used to seed the inputs when the dialog opens
   * and to decide whether the "Clear status" action is shown.
   */
  value?: CustomStatusValue;
  /**
   * Persist the edited status. May be async; while it resolves the footer
   * buttons are disabled and the primary button shows a saving label.
   * The dialog closes once it resolves.
   */
  onSave: (value: CustomStatusValue) => void | Promise<void>;
  /**
   * Clear the custom status. When omitted, falls back to calling `onSave`
   * with empty text/emoji. The "Clear status" button only renders when the
   * current `value` has a text or emoji set.
   */
  onClear?: () => void | Promise<void>;
  /** Dialog heading. */
  title?: string;
  /** Placeholder for the status-message input. */
  placeholder?: string;
  /** Placeholder for the emoji input. */
  emojiPlaceholder?: string;
  /** Label above the inputs. */
  label?: string;
  /** "Clear status" button label. */
  clearLabel?: string;
  /** "Cancel" button label. */
  cancelLabel?: string;
  /** "Save" button label. */
  saveLabel?: string;
  /** Label shown on the primary button while a save/clear is in flight. */
  savingLabel?: string;
}

/**
 * Presence-free custom-status editor. The platform wires this to its presence
 * context via props; other apps can reuse it with any persistence backend.
 */
export function CustomStatusDialog({
  open,
  onOpenChange,
  value,
  onSave,
  onClear,
  title = "Set a custom status",
  placeholder = "What's your status?",
  emojiPlaceholder = "😊",
  label = "Status message",
  clearLabel = "Clear status",
  cancelLabel = "Cancel",
  saveLabel = "Save",
  savingLabel = "Saving...",
}: CustomStatusDialogProps) {
  const [statusText, setStatusText] = useState(value?.statusText || "");
  const [statusEmoji, setStatusEmoji] = useState(value?.statusEmoji || "");
  const [saving, setSaving] = useState(false);

  // Re-seed the inputs from the incoming value each time the dialog opens so
  // it always reflects the latest persisted status, not a stale local edit.
  useEffect(() => {
    if (open) {
      setStatusText(value?.statusText || "");
      setStatusEmoji(value?.statusEmoji || "");
    }
  }, [open, value?.statusText, value?.statusEmoji]);

  const handleSave = async () => {
    setSaving(true);
    await onSave({
      statusText: statusText.trim() || undefined,
      statusEmoji: statusEmoji || undefined,
    });
    setSaving(false);
    onOpenChange(false);
  };

  const handleClear = async () => {
    setSaving(true);
    if (onClear) {
      await onClear();
    } else {
      await onSave({ statusText: undefined, statusEmoji: undefined });
    }
    setSaving(false);
    setStatusText("");
    setStatusEmoji("");
    onOpenChange(false);
  };

  const hasExistingStatus = Boolean(value?.statusText || value?.statusEmoji);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[350px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{label}</Label>
            <div className="flex gap-2">
              <Input
                value={statusEmoji}
                onChange={(e) => setStatusEmoji(e.target.value)}
                placeholder={emojiPlaceholder}
                className="w-14 text-center"
                maxLength={4}
              />
              <Input
                value={statusText}
                onChange={(e) => setStatusText(e.target.value)}
                placeholder={placeholder}
                className="flex-1"
                autoFocus
              />
            </div>
          </div>
        </div>
        <DialogFooter className="flex gap-2">
          {hasExistingStatus && (
            <Button
              variant="ghost"
              onClick={handleClear}
              disabled={saving}
              className="mr-auto"
            >
              {clearLabel}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? savingLabel : saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
