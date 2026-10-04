/** Import a CSV export from another password manager into a vault. */

import { useRef, useState } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import type {
  WeldPassImportFormat,
  WeldPassImportNote,
  WeldPassItemImportResult,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { useImportWeldPassItems } from '@/hooks/queries/use-weldpass-passwords-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { usePasswordsT } from '../lib/use-passwords-t';

/** The API refuses anything larger. */
const MAX_BYTES = 5 * 1024 * 1024;

const FORMATS: Array<{ value: WeldPassImportFormat; label?: string }> = [
  { value: 'auto' },
  { value: 'lastpass', label: 'LastPass' },
  { value: 'nordpass', label: 'NordPass' },
  { value: '1password', label: '1Password' },
  { value: 'bitwarden', label: 'Bitwarden' },
  { value: 'chrome', label: 'Chrome / Edge' },
];

function NoteList({
  title,
  notes,
}: Readonly<{ title: string; notes: WeldPassImportNote[] }>) {
  const tp = usePasswordsT();
  if (notes.length === 0) return null;
  return (
    <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-3">
      <p className="text-xs font-medium">{title}</p>
      {notes.map((note) => (
        <p key={`${note.line}-${note.reason}`} className="text-xs text-muted-foreground">
          {tp('import.noteLine', { line: note.line, reason: note.reason })}
        </p>
      ))}
    </div>
  );
}

export function ImportDialog({
  vaults,
  vaultLabel,
  defaultVaultId,
  onClose,
}: Readonly<{
  /** Vaults the caller can write to. */
  vaults: WeldPassVault[];
  vaultLabel: (vault: WeldPassVault) => string;
  defaultVaultId: string;
  onClose: () => void;
}>) {
  const tp = usePasswordsT();
  const importItems = useImportWeldPassItems();
  const fileInput = useRef<HTMLInputElement>(null);

  const [vaultId, setVaultId] = useState(defaultVaultId);
  const [format, setFormat] = useState<WeldPassImportFormat>('auto');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<WeldPassItemImportResult | null>(null);

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setFailure(null);
    if (file.size > MAX_BYTES) {
      setFailure(tp('import.tooLarge'));
      return;
    }
    try {
      setContent(await file.text());
      setFileName(file.name);
    } catch {
      setFailure(tp('import.readFailed'));
    }
  }

  async function submit() {
    setFailure(null);
    try {
      const res = await importItems.mutateAsync({ vaultId, content, format });
      setResult(res.data);
    } catch (err) {
      setFailure(errorMessage(err, tp('import.failed')));
    }
  }

  if (result) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tp('import.completeTitle')}</DialogTitle>
            <DialogDescription>
              {tp('import.detectedFormat', { format: result.format })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge variant="success">{tp('import.created', { count: result.created })}</Badge>
              {result.skipped.length > 0 && (
                <Badge variant="warning">
                  {tp('import.skipped', { count: result.skipped.length })}
                </Badge>
              )}
              {result.warnings.length > 0 && (
                <Badge variant="outline">
                  {tp('import.warnings', { count: result.warnings.length })}
                </Badge>
              )}
            </div>
            <NoteList title={tp('import.skippedTitle')} notes={result.skipped} />
            <NoteList title={tp('import.warningsTitle')} notes={result.warnings} />
            <p className="text-xs text-muted-foreground">{tp('import.deleteFileNote')}</p>
          </div>

          <DialogFooter>
            <Button onClick={onClose}>{tp('import.done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !importItems.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tp('import.title')}</DialogTitle>
          <DialogDescription>{tp('import.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="weldpass-import-vault">{tp('import.vault')}</Label>
              <Select value={vaultId} onValueChange={setVaultId}>
                <SelectTrigger id="weldpass-import-vault">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {vaults.map((vault) => (
                    <SelectItem key={vault.id} value={vault.id}>
                      {vaultLabel(vault)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="weldpass-import-format">{tp('import.format')}</Label>
              <Select
                value={format}
                onValueChange={(value) => setFormat(value as WeldPassImportFormat)}
              >
                <SelectTrigger id="weldpass-import-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORMATS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label ?? tp('import.formatAuto')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{tp('import.file')}</Label>
            <div className="flex items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv,text/plain"
                className="hidden"
                onChange={(event) => {
                  void pickFile(event.target.files?.[0]);
                  // Let the same file be picked again after a clear.
                  event.target.value = '';
                }}
              />
              <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
                <FileUp className="mr-1.5 h-4 w-4" />
                {tp('import.chooseFile')}
              </Button>
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {fileName ?? tp('import.noFile')}
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="weldpass-import-content">{tp('import.pasteLabel')}</Label>
            <Textarea
              id="weldpass-import-content"
              rows={8}
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setFileName(null);
              }}
              placeholder="name,url,username,password,note"
              className="font-mono text-xs"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">{tp('import.pasteHint')}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={importItems.isPending}>
            {tp('common.cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!content.trim() || !vaultId || importItems.isPending}
          >
            {importItems.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {tp('import.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
