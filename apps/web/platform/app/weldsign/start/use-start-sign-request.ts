/**
 * "Send for signature" from outside WeldSign: a PDF in WeldDrive, or a CRM
 * company, person or opportunity. It makes a draft that remembers where it
 * came from (so the signed PDF is filed back there) and opens it:
 *
 * - from a file: the PDF is copied in as the first document and the draft
 *   opens on Recipients; if the PDF is refused the draft still opens, on
 *   Documents, with the server's reason in a toast;
 * - from a record: the draft opens on Documents.
 *
 * `available` is false where the workspace has no WeldSign or the member may
 * not create requests; callers then leave the action out.
 */

import { useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { useIsAppInstalled } from '@/hooks/use-is-app-installed';
import { useStartSignEnvelope } from '@/hooks/queries/use-weldsign-queries';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { apiErrorMessage } from '../lib/errors';
import { clampTitle, fileTitle, type SignStartSource } from '../lib/source';

type Format = ReturnType<typeof useI18n>['format'];

/** The title of the draft: the file's name without .pdf, or "Document for {record}"; the untitled label when there is no name. */
function draftTitle(source: SignStartSource, strings: { recordTitle: string; untitled: string }, format: Format): string {
  const name = source.name.trim();
  if (source.entityType === 'file') return fileTitle(name, strings.untitled);
  if (!name) return strings.untitled;
  return clampTitle(format(strings.recordTitle, { name }));
}

export function useStartSignRequest() {
  const { t, format } = useI18n();
  const router = useRouter();
  const installed = useIsAppInstalled('weldsign');
  const canCreate = useCan('sign_envelopes:create');
  const { mutateAsync, isPending } = useStartSignEnvelope();
  const running = useRef(false);

  const start = useCallback(
    async (source: SignStartSource) => {
      // A second click while the first request is being made must not make a second draft.
      if (running.current) return;
      running.current = true;

      const ts = t.weldsign.start;
      const untitled = t.weldsign.home.untitled;
      const isFile = source.entityType === 'file';
      const name = source.name.trim();
      const title = draftTitle(source, { recordTitle: ts.recordTitle, untitled }, format);
      const progress = isFile ? toast.loading(format(ts.preparing, { name: name || untitled })) : null;

      try {
        const { envelope, documentError } = await mutateAsync({
          input: { title, source: { entityType: source.entityType, entityId: source.id } },
          fileId: isFile ? source.id : undefined,
        });
        if (documentError) {
          toast.error(format(ts.documentFailed, { name: name || untitled, reason: apiErrorMessage(documentError) }));
        }
        const step = isFile && !documentError ? '?step=recipients' : '';
        router.push(`/weldsign/${envelope.id}${step}`);
      } catch (err) {
        toast.error(`${ts.failed}: ${apiErrorMessage(err)}`);
      } finally {
        if (progress !== null) toast.dismiss(progress);
        running.current = false;
      }
    },
    [format, mutateAsync, router, t],
  );

  return { available: installed && canCreate, starting: isPending, start };
}
