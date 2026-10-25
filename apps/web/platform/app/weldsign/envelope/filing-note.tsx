/**
 * Where the signed PDF of a completed request was saved: the WeldDrive file and
 * folder, and, for a request that started from a CRM record, the record it was
 * also saved on. Nothing is shown until the request has been filed.
 */

import { HardDrive } from 'lucide-react';
import type { SignEnvelopeDetail, SignSourceDto } from '@weldsuite/app-api-client/schemas/weldsign';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { driveFolderHref, sourceHref } from '../lib/source';
import { LinkedName, SOURCE_ICON } from './source-line';

type RecordType = 'company' | 'person';

const linkClass = 'font-medium text-foreground underline-offset-4 hover:underline';

export function FilingNote({ envelope }: Readonly<{ envelope: SignEnvelopeDetail }>) {
  const { t } = useI18n();
  const to = t.weldsign.overview.filing;
  const filing = envelope.filing ?? null;
  if (!filing) return null;

  return (
    <section className="flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm" aria-label={to.title}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <HardDrive className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span>{to.drive}</span>
        {filing.driveFileId && (
          <Link href={sourceHref('file', filing.driveFileId)} className={linkClass}>
            {to.viewFile}
          </Link>
        )}
        {filing.driveFolderId && (
          <Link href={driveFolderHref(filing.driveFolderId)} className={linkClass}>
            {to.openFolder}
          </Link>
        )}
      </p>
      {filing.recordType && filing.recordId && (
        <RecordLine recordType={filing.recordType} recordId={filing.recordId} source={envelope.source ?? null} />
      )}
    </section>
  );
}

/**
 * "Saved on Acme BV". The record's own name is known when the request started
 * from it; for an opportunity's company it is not, so the line says "the company".
 */
function RecordLine({ recordType, recordId, source }: Readonly<{ recordType: RecordType; recordId: string; source: SignSourceDto | null }>) {
  const { t } = useI18n();
  const to = t.weldsign.overview.filing;
  const Icon = SOURCE_ICON[recordType];
  const sameRecord = source?.entityType === recordType && source.entityId === recordId;
  const name = (sameRecord ? source?.name : null) ?? to.recordFallback[recordType];

  return (
    <p className="flex items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <LinkedName template={to.onRecord} name={name} href={sourceHref(recordType, recordId)} />
    </p>
  );
}
