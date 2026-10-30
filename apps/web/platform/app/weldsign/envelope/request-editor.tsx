/**
 * A draft request on one page, laid out as an invoice is in WeldBooks: the
 * documents on the left, with their fields placed on the pages, and the request
 * on the right (documents, recipients, fields, settings, then what it holds).
 * Save and Send are in the bar on top.
 *
 * Everything but the fields is saved as it is changed; the fields are saved
 * with Save, before Send, and when the page is left.
 */

import type { ReactNode } from 'react';
import { FileText, Loader2, Settings2, Signature, Users, type LucideIcon } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import type { SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { targetOf, useUpdateSignEnvelope } from '@/hooks/queries/use-weldsign-queries';
import { EnvelopeStatusBadge } from '../components/status-badge';
import { readinessProblems } from '../lib/readiness';
import { DocumentDialogs, DocumentList, DocumentsEmptyState, DropOverlay, useDocuments } from './documents-step';
import { EditorHeader, type EditorBack } from './editor-frame';
import { documentAnchor, FieldPages, FieldTools, useFieldEditor } from './fields-step';
import { RecipientsStep } from './recipients-step';
import { ReviewSettings, ReviewSummary, SendButton } from './review-step';

interface RequestEditorProps {
  envelope: SignEnvelopeDetail;
  editable: boolean;
  back: EditorBack;
  /** A strip under the header, for example "read only". */
  banner?: ReactNode;
}

export function RequestEditor({ envelope, editable, back, banner }: Readonly<RequestEditorProps>) {
  const { t, format } = useI18n();
  const te = t.weldsign.editor;
  const update = useUpdateSignEnvelope(targetOf(envelope));
  const docs = useDocuments(envelope, editable);
  const editor = useFieldEditor(envelope, editable);
  // Checked against the fields as they are on the page, saved or not: Send saves them first.
  const problems = readinessProblems({ documents: envelope.documents, recipientList: envelope.recipientList, fields: editor.fields });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader
        title={envelope.title}
        titleLabel={te.titleLabel}
        onRename={editable ? (next) => update.mutate({ title: next.slice(0, 255) }) : undefined}
        back={back}
        badge={<EnvelopeStatusBadge status={envelope.status} />}
      >
        {editable && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={!editor.dirty || editor.saving}
              // The save reports its own failure.
              onClick={() => editor.save().catch(() => undefined)}
            >
              {editor.saving && <Loader2 className="animate-spin" />}
              {editor.saving ? te.saving : te.save}
            </Button>
            <SendButton envelope={envelope} editable={editable} problems={problems} beforeSend={editor.dirty ? editor.save : undefined} />
          </>
        )}
      </EditorHeader>

      {banner}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <section
          aria-label={te.preview}
          className="relative order-2 flex min-w-0 flex-col bg-muted/40 lg:order-1 lg:min-h-0 lg:flex-1"
          {...docs.dropHandlers}
        >
          {editor.armed && (
            <div className="pointer-events-none absolute left-1/2 top-4 z-10 w-max max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-md border bg-background px-3 py-1.5 text-center text-sm shadow-sm">
              {format(te.fields.placing, { type: te.fields.types[editor.armed] })}
            </div>
          )}
          <div className="custom-scrollbar flex flex-1 flex-col px-4 py-6 lg:min-h-0 lg:overflow-y-auto lg:px-8 lg:py-8">
            {envelope.documents.length === 0 ? (
              <div className="m-auto">
                <DocumentsEmptyState docs={docs} />
              </div>
            ) : (
              <FieldPages editor={editor} />
            )}
          </div>
          {docs.dragOver && <DropOverlay />}
        </section>

        <aside className="custom-scrollbar order-1 shrink-0 border-border lg:order-2 lg:w-[480px] lg:overflow-y-auto lg:border-l xl:w-[540px]">
          <PanelSection icon={FileText} title={te.documents.title} description={te.documents.description}>
            <DocumentList
              docs={docs}
              onOpen={(doc) => document.getElementById(documentAnchor(doc.id))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            />
          </PanelSection>

          <PanelSection icon={Users} title={te.recipients.title} description={te.recipients.description}>
            <RecipientsStep envelope={envelope} editable={editable} />
          </PanelSection>

          <PanelSection icon={Signature} title={te.fields.title} description={editable ? te.fields.description : undefined}>
            <FieldTools editor={editor} panel />
          </PanelSection>

          <PanelSection icon={Settings2} title={te.steps.settings}>
            <ReviewSettings envelope={envelope} editable={editable} />
          </PanelSection>

          <div className="space-y-3 px-5 py-5">
            <ReviewSummary counts={{ documents: envelope.documents.length, recipients: envelope.recipientList.length, fields: editor.fields.length }} />
          </div>
        </aside>
      </div>

      <DocumentDialogs docs={docs} />
    </div>
  );
}

/** One part of the panel, as the sections of the invoice editor are. The description shows on hovering the title. */
function PanelSection({ icon: Icon, title, description, children }: Readonly<{ icon: LucideIcon; title: string; description?: string; children: ReactNode }>) {
  const heading = (
    <h2 className="flex w-fit items-center gap-2 text-sm font-semibold">
      <Icon className="h-4 w-4 text-muted-foreground" />
      {title}
    </h2>
  );
  return (
    <section aria-label={title} className="border-b border-border px-5 py-5">
      <div className="mb-4">
        {description ? (
          <Tooltip>
            <TooltipTrigger asChild>{heading}</TooltipTrigger>
            <TooltipContent side="top" align="start" className="max-w-xs">
              {description}
            </TooltipContent>
          </Tooltip>
        ) : (
          heading
        )}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
