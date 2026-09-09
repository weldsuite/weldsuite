/** Add / edit, import and history dialogs for a WeldPass environment. */

import { useState } from 'react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useTranslations } from '@weldsuite/i18n/client';
import type {
  WeldPassAutoSyncOutcome,
  WeldPassImportResult,
  WeldPassSecret,
} from '@weldsuite/app-api-client/domains/weldpass';
import {
  useCreateWeldPassSecret,
  useImportWeldPassSecrets,
  useRestoreWeldPassSecret,
  useRevealWeldPassSecret,
  useUpdateWeldPassSecret,
  useWeldPassSecretVersions,
} from '@/hooks/queries/use-weldpass-queries';
import { ErrorBanner, InlineSpinner, TimeAgo, errorMessage } from './shared';

export function SecretDialog({
  projectId,
  environmentId,
  secret,
  onClose,
  onSaved,
}: {
  projectId: string;
  environmentId: string;
  secret?: WeldPassSecret;
  onClose: () => void;
  onSaved: (autoSync: WeldPassAutoSyncOutcome[]) => void;
}) {
  const t = useTranslations();
  const createSecret = useCreateWeldPassSecret(projectId, environmentId);
  const updateSecret = useUpdateWeldPassSecret(projectId, environmentId);

  const [key, setKey] = useState(secret?.key ?? '');
  const [value, setValue] = useState('');
  const [note, setNote] = useState(secret?.note ?? '');
  const [failure, setFailure] = useState<string | null>(null);

  const pending = createSecret.isPending || updateSecret.isPending;

  async function submit() {
    setFailure(null);
    try {
      if (secret) {
        const res = await updateSecret.mutateAsync({
          secretId: secret.id,
          // An empty box means "leave the value alone", not "set it to empty".
          value: value === '' ? undefined : value,
          note: note.trim() || null,
        });
        onSaved(res.data.autoSync);
      } else {
        const res = await createSecret.mutateAsync({
          key: key.trim(),
          value,
          note: note.trim() || null,
        });
        onSaved(res.data.autoSync);
      }
    } catch (err) {
      setFailure(errorMessage(err, t('weldpass.secrets.form.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {secret
              ? t('weldpass.secrets.form.editTitle', { key: secret.key })
              : t('weldpass.secrets.form.addTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          {!secret && (
            <div className="space-y-1.5">
              <Label htmlFor="weldpass-secret-key">{t('weldpass.secrets.form.keyLabel')}</Label>
              <Input
                id="weldpass-secret-key"
                value={key}
                onChange={(event) => setKey(event.target.value.toUpperCase())}
                placeholder="DATABASE_URL"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                {t('weldpass.secrets.form.keyHint')}
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="weldpass-secret-value">
              {t('weldpass.secrets.form.valueLabel')}
            </Label>
            <Textarea
              id="weldpass-secret-value"
              rows={3}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={secret ? '••••••••' : 'postgres://…'}
              className="font-mono text-xs"
            />
            {secret && (
              <p className="text-xs text-muted-foreground">
                {t('weldpass.secrets.form.valueKeepHint')}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="weldpass-secret-note">{t('weldpass.secrets.form.noteLabel')}</Label>
            <Input
              id="weldpass-secret-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('weldpass.secrets.form.noteHint')}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('weldpass.secrets.form.cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={pending || (!secret && (!key.trim() || value === ''))}
          >
            {t('weldpass.secrets.form.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImportDialog({
  projectId,
  environmentId,
  onClose,
  onImported,
}: {
  projectId: string;
  environmentId: string;
  onClose: () => void;
  onImported: (result: WeldPassImportResult) => void;
}) {
  const t = useTranslations();
  const importSecrets = useImportWeldPassSecrets(projectId, environmentId);

  const [content, setContent] = useState('');
  const [replace, setReplace] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<WeldPassImportResult | null>(null);

  async function submit() {
    setFailure(null);
    try {
      const res = await importSecrets.mutateAsync({ content, replace });
      setResult(res.data);
    } catch (err) {
      setFailure(errorMessage(err, t('weldpass.secrets.import.failed')));
    }
  }

  if (result) {
    return (
      <Dialog open onOpenChange={() => onImported(result)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('weldpass.secrets.import.completeTitle')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge>{t('weldpass.secrets.import.added', { count: result.created.length })}</Badge>
              <Badge variant="secondary">
                {t('weldpass.secrets.import.updated', { count: result.updated.length })}
              </Badge>
              <Badge variant="outline">
                {t('weldpass.secrets.import.unchanged', { count: result.unchanged.length })}
              </Badge>
              {result.removed.length > 0 && (
                <Badge variant="destructive">
                  {t('weldpass.secrets.import.removed', { count: result.removed.length })}
                </Badge>
              )}
            </div>

            {result.skipped.length > 0 && (
              <div className="space-y-1 rounded-md border p-3">
                <p className="text-xs font-medium">{t('weldpass.secrets.import.skippedTitle')}</p>
                {result.skipped.map((skip) => (
                  <p key={skip.line} className="text-xs text-muted-foreground">
                    {t('weldpass.secrets.import.skippedLine', {
                      line: skip.line,
                      reason: skip.reason,
                    })}
                  </p>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button onClick={() => onImported(result)}>
              {t('weldpass.secrets.import.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('weldpass.secrets.import.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label htmlFor="weldpass-import">{t('weldpass.secrets.import.pasteLabel')}</Label>
            <Textarea
              id="weldpass-import"
              rows={12}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={'DATABASE_URL=postgres://…\nAPI_KEY="sk_live_…"'}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              {t('weldpass.secrets.import.pasteHint')}
            </p>
          </div>

          <label className="flex items-start gap-2 text-xs">
            <Checkbox
              checked={replace}
              onCheckedChange={(checked) => setReplace(checked === true)}
              className="mt-0.5"
            />
            <span>{t('weldpass.secrets.import.replaceLabel')}</span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('weldpass.secrets.form.cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!content.trim() || importSecrets.isPending}
          >
            {t('weldpass.secrets.import.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HistoryDialog({
  projectId,
  environmentId,
  secret,
  onClose,
  onRestored,
}: {
  projectId: string;
  environmentId: string;
  secret: WeldPassSecret;
  onClose: () => void;
  onRestored: () => void;
}) {
  const t = useTranslations();
  const { data: versions, isLoading, error } = useWeldPassSecretVersions(
    projectId,
    environmentId,
    secret.id,
  );
  const restore = useRestoreWeldPassSecret(projectId, environmentId);
  const [failure, setFailure] = useState<string | null>(null);

  async function restoreVersion(version: number) {
    setFailure(null);
    try {
      await restore.mutateAsync({ secretId: secret.id, version });
      onRestored();
    } catch (err) {
      setFailure(errorMessage(err, t('weldpass.secrets.versions.restoreFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t('weldpass.secrets.versions.title', { key: secret.key })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <ErrorBanner
            error={
              failure ?? (error ? errorMessage(error, t('weldpass.secrets.versions.loadFailed')) : null)
            }
          />

          {isLoading ? (
            <InlineSpinner />
          ) : (
            <div className="space-y-1">
              {versions?.map((version) => (
                <div
                  key={version.id}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium">
                      v{version.version} · {version.action}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <TimeAgo value={version.createdAt} />
                      <span className="ml-1 font-mono opacity-60">
                        {version.checksum.slice(0, 8)}
                      </span>
                    </p>
                  </div>
                  {version.version !== secret.version && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={restore.isPending}
                      onClick={() => void restoreVersion(version.version)}
                    >
                      {t('weldpass.secrets.versions.restore')}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {t('weldpass.secrets.versions.restoreNote')}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Reveal is a hook the row calls; kept here so all secret-value UI lives together. */
export function useRevealer(projectId: string, environmentId: string) {
  return useRevealWeldPassSecret(projectId, environmentId);
}
