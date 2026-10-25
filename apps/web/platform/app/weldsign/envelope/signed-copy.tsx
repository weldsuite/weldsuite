/**
 * The review step's "Signed copy": where the signed PDF will be saved in
 * WeldDrive once everyone has signed (the default place, or a folder the sender
 * chose), and, for a request that started from a CRM record, that a copy also
 * goes on the record. The source of the request is shown with it.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import type { SignEnvelopeDetail, SignSourceDto } from '@weldsuite/app-api-client/schemas/weldsign';
import { DriveFolderPickerDialog } from '@/app/welddrive/components/drive-folder-picker-dialog';
import type { DriveFolder } from '@/lib/api/domains/welddrive';
import { useAllDriveFolders } from '@/hooks/queries/use-drive-queries';
import { useSetSignFileBackFolder } from '@/hooks/queries/use-weldsign-queries';
import { useI18n } from '@/lib/i18n/provider';
import { apiErrorMessage } from '../lib/errors';
import { SourceLine } from './source-line';

type Strings = ReturnType<typeof useI18n>['t']['weldsign']['editor']['review']['signedCopy'];
type Format = ReturnType<typeof useI18n>['format'];

/** What is also saved on the CRM record, in a sentence; null for a request that did not start there. */
function recordNote(source: SignSourceDto | null, ts: Strings, format: Format): string | null {
  if (!source?.name) return null;
  if (source.entityType === 'company' || source.entityType === 'person') return format(ts.alsoRecord, { name: source.name });
  if (source.entityType === 'opportunity') return format(ts.alsoOpportunity, { name: source.name });
  return null;
}

export function SignedCopy({ envelope, editable }: Readonly<{ envelope: SignEnvelopeDetail; editable: boolean }>) {
  const { t, format } = useI18n();
  const ts = t.weldsign.editor.review.signedCopy;
  const setFolder = useSetSignFileBackFolder(envelope.id);
  const canReadFolders = useCan('folders:read');
  const folderId = envelope.fileBackFolderId ?? null;
  const source = envelope.source ?? null;
  // Only a chosen folder needs looking up, to name it.
  const folders = useAllDriveFolders(canReadFolders && folderId !== null);
  const [choosing, setChoosing] = useState(false);

  const folderName = folders.data?.data.find((folder) => folder.id === folderId)?.name;
  let where = format(ts.toDefault, { year: new Date().getFullYear() });
  if (folderId !== null) where = folderName ? format(ts.toFolder, { name: folderName }) : ts.toFolderUnknown;
  const note = recordNote(source, ts, format);

  async function save(next: string | null) {
    try {
      await setFolder.mutateAsync(next);
    } catch (err) {
      toast.error(`${ts.saveFailed}: ${apiErrorMessage(err)}`);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" aria-label={ts.title}>
      <SourceLine source={source} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-sm font-medium">{ts.title}</h3>
          <p className="text-sm text-muted-foreground">{where}</p>
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
        </div>
        {editable && (
          <div className="flex items-center gap-1">
            {canReadFolders && (
              <Button variant="outline" size="sm" disabled={setFolder.isPending} onClick={() => setChoosing(true)}>
                {ts.change}
              </Button>
            )}
            {folderId !== null && (
              <Button variant="ghost" size="sm" disabled={setFolder.isPending} onClick={() => void save(null)}>
                {ts.useDefault}
              </Button>
            )}
          </div>
        )}
      </div>

      {choosing && (
        <DriveFolderPickerDialog
          title={ts.pickTitle}
          description={ts.pickDescription}
          confirmLabel={ts.pickConfirm}
          selectedFolderId={folderId}
          onPick={(folder: DriveFolder) => save(folder.id)}
          onClose={() => setChoosing(false)}
        />
      )}
    </section>
  );
}
