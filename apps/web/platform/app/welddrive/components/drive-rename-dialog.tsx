import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { isApiError } from '@weldsuite/api-client';
import { isValidDriveName, RESERVED_DRIVE_NAME_CHARS } from '@weldsuite/core-api-client/schemas/files';
import { useI18n } from '@/lib/i18n/provider';
import { splitExtension } from './drive-utils';

interface DriveRenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
  title: string;
  /**
   * Files: only the name before the extension is selected, and a name typed
   * without an extension keeps the old one ("E2E renamed" → "E2E renamed.png").
   */
  keepExtension?: boolean;
  /** Saves the new name; a rejection is shown in the dialog. */
  onRename: (newName: string) => Promise<unknown>;
}

/** The name the dialog will save: trimmed, with the file's extension kept when none was typed. */
export function resolveDriveRename(input: string, currentName: string, keepExtension: boolean): string {
  const name = input.trim();
  if (!keepExtension || !name) return name;
  const [, currentExt] = splitExtension(currentName);
  const [, typedExt] = splitExtension(name);
  return currentExt && !typedExt ? `${name}${currentExt}` : name;
}

export function DriveRenameDialog({
  open,
  onOpenChange,
  currentName,
  title,
  keepExtension = false,
  onRename,
}: Readonly<DriveRenameDialogProps>) {
  const { t } = useI18n();
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(currentName);
      setError(null);
      setSaving(false);
    }
  }, [open, currentName]);

  const nextName = resolveDriveRename(name, currentName, keepExtension);
  const unchanged = !nextName || nextName === currentName;

  const handleRename = async () => {
    if (unchanged || saving) return;
    if (!isValidDriveName(nextName)) {
      setError(t.welddrive.rename.invalidCharacters.replace('{chars}', RESERVED_DRIVE_NAME_CHARS));
      return;
    }
    setSaving(true);
    try {
      await onRename(nextName);
      onOpenChange(false);
    } catch (err) {
      setError(isApiError(err) && err.status === 409 ? t.welddrive.rename.nameTaken : t.welddrive.rename.failed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[460px]"
        onOpenAutoFocus={(e) => {
          // Select the name without its extension, like Finder and Google Drive.
          e.preventDefault();
          const input = inputRef.current;
          if (!input) return;
          input.focus();
          const baseLength = keepExtension ? splitExtension(currentName)[0].length : currentName.length;
          input.setSelectionRange(0, baseLength);
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2 py-4">
          <Label htmlFor="drive-rename-input">{t.welddrive.rename.nameLabel}</Label>
          <Input
            ref={inputRef}
            id="drive-rename-input"
            value={name}
            aria-invalid={!!error}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleRename();
              }
            }}
          />
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : (
            keepExtension && nextName !== name.trim() && !unchanged && (
              <p className="text-xs text-muted-foreground">
                {t.welddrive.rename.willBeSavedAs.replace('{name}', nextName)}
              </p>
            )
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.welddrive.rename.cancel}
          </Button>
          <Button onClick={() => void handleRename()} disabled={unchanged || saving}>
            {t.welddrive.rename.rename}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
