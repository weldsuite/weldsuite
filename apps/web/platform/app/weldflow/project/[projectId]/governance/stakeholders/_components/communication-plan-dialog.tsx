import { useRef, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import type { CommunicationPlanEntry } from '@weldsuite/app-api-client/domains/project-reporting';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useCommunicationPlan, usePutCommunicationPlan } from '@/hooks/queries/use-project-reporting-queries';
import { EditorDialog } from './editor-dialog';

const FIELDS = ['what', 'audience', 'cadence', 'channel'] as const;
/** The API's limits per field, so an input stops where the request would be refused. */
const MAX_LENGTH: Record<(typeof FIELDS)[number], number> = { what: 255, audience: 500, cadence: 100, channel: 255 };
/** What, who, how often and channel: the first two get more room than the last two. */
const ROW_GRID = 'grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_2rem]';

/** A row of the plan being edited, with a key of its own so a removed row does not hand its place to the next. */
interface PlanRow extends CommunicationPlanEntry {
  key: number;
}

interface CommunicationPlanDialogProps {
  projectId: string;
  open: boolean;
  /** Whether the member may change the plan; otherwise it is only shown. */
  canEdit: boolean;
  onClose: () => void;
}

/** The communication plan of the project: what is shared, with whom, how often and where. */
export function CommunicationPlanDialog({ open, ...props }: Readonly<CommunicationPlanDialogProps>) {
  // Mounted only while open, so each opening starts from the saved plan.
  return open ? <PlanEditor {...props} /> : null;
}

function PlanEditor({ projectId, canEdit, onClose }: Readonly<Omit<CommunicationPlanDialogProps, 'open'>>) {
  const { t } = useI18n();
  const stakeholders = t.flowReporting.stakeholders;
  const copy = stakeholders.plan;
  const query = useCommunicationPlan(projectId);
  const save = usePutCommunicationPlan();
  // The rows being edited; until the first edit they are the saved ones (negative keys, as new rows count up from 0).
  const [draft, setDraft] = useState<PlanRow[] | null>(null);
  const newKey = useRef(0);
  const rows: PlanRow[] = draft ?? (query.data?.communicationPlan ?? []).map((entry, index) => ({ ...entry, key: -(index + 1) }));
  const complete = rows.every((row) => FIELDS.every((field) => row[field].trim()));

  const setField = (index: number, field: (typeof FIELDS)[number], value: string) =>
    setDraft(rows.map((row, at) => (at === index ? { ...row, [field]: value } : row)));

  const submit = async () => {
    try {
      await save.mutateAsync({
        projectId,
        input: { communicationPlan: rows.map((row) => ({ what: row.what.trim(), audience: row.audience.trim(), cadence: row.cadence.trim(), channel: row.channel.trim() })) },
      });
      toast.success(copy.saved);
      onClose();
    } catch {
      toast.error(stakeholders.saveFailed);
    }
  };

  let body;
  if (query.isLoading) body = <InlineSpinner />;
  else if (query.isError && !query.data) body = <ErrorState onRetry={() => void query.refetch()} />;
  else {
    body = (
      <>
        <div aria-hidden className={cn(ROW_GRID, 'hidden px-0.5 text-xs font-medium text-muted-foreground sm:grid')}>
          {FIELDS.map((field) => (
            <span key={field}>{copy[field]}</span>
          ))}
          <span />
        </div>
        {rows.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">{copy.empty}</p> : null}
        {rows.map((row, index) => (
          <div key={row.key} className={ROW_GRID}>
            {FIELDS.map((field) => (
              <Input
                key={field}
                aria-label={`${copy[field]} ${index + 1}`}
                placeholder={copy[field]}
                maxLength={MAX_LENGTH[field]}
                disabled={!canEdit}
                value={row[field]}
                onChange={(event) => setField(index, field, event.target.value)}
              />
            ))}
            {canEdit ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`${copy.remove} ${index + 1}`}
                title={copy.remove}
                onClick={() => setDraft(rows.filter((_, at) => at !== index))}
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </Button>
            ) : null}
          </div>
        ))}
        {canEdit ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start text-muted-foreground shadow-none"
            onClick={() => setDraft([...rows, { key: newKey.current++, what: '', audience: '', cadence: '', channel: '' }])}
          >
            <Plus aria-hidden />
            {copy.add}
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <EditorDialog
      title={copy.title}
      onClose={onClose}
      onSubmit={canEdit ? () => void submit() : undefined}
      footer={
        canEdit ? (
          <>
            <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
              {t.flowGovernance.common.cancel}
            </Button>
            <Button type="submit" disabled={save.isPending || !complete || query.isLoading}>
              {save.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {stakeholders.form.save}
            </Button>
          </>
        ) : (
          <Button type="button" variant="outline" onClick={onClose}>
            {t.flowGovernance.common.close}
          </Button>
        )
      }
    >
      {body}
    </EditorDialog>
  );
}
