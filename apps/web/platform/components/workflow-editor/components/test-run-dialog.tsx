import { useEffect, useId, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
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
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useI18n } from '@/lib/i18n/provider';

export interface TestRecordField {
  path: string;
  label: string;
  sample?: string;
}

export interface TestRunRequest {
  triggerType?: string;
  testData: Record<string, unknown>;
}

interface TestRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The workflow's trigger, as stored (flat or with fields nested under `config`). */
  trigger: (Record<string, unknown> & { type?: string }) | undefined;
  /** Display name of the trigger's entity (entity-event triggers). */
  entityLabel?: string;
  /** Known fields of the trigger's record; without them the sample is edited as JSON. */
  recordFields?: TestRecordField[];
  /** Email address pre-filled into the sample's `email`, so test mails reach the tester. */
  testerEmail?: string;
  hasUnsavedChanges: boolean;
  isRunning: boolean;
  onRun: (request: TestRunRequest) => void;
}

const FALLBACK_SAMPLE = '{\n  "id": "test-record"\n}';

function triggerField(trigger: TestRunDialogProps['trigger'], key: string): string {
  const value = trigger?.[key] ?? (trigger?.config as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : '';
}

/** `{ 'address.city': 'X', name: 'Y' }` → `{ address: { city: 'X' }, name: 'Y' }`, skipping blanks. */
function buildSampleRecord(values: Record<string, string>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(values)) {
    if (value === '') continue;
    const keys = path.split('.');
    let target = record;
    for (const key of keys.slice(0, -1)) {
      target[key] = (target[key] as Record<string, unknown> | undefined) ?? {};
      target = target[key] as Record<string, unknown>;
    }
    target[keys[keys.length - 1]] = value;
  }
  return record;
}

function parseSampleJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Confirmation step in front of the editor's "Test" button. A test is a real
 * run (emails are sent, records are created), so it says so, and it lets the
 * tester supply the record an entity-event workflow would normally receive:
 * with an empty payload every `{{trigger.record.*}}` resolved to nothing.
 */
export function TestRunDialog({
  open,
  onOpenChange,
  trigger,
  entityLabel,
  recordFields,
  testerEmail,
  hasUnsavedChanges,
  isRunning,
  onRun,
}: Readonly<TestRunDialogProps>) {
  const { t } = useI18n();
  const td = t.weldconnect.workflowEditorClient.testDialog;
  const fieldIdPrefix = useId();
  const isEntityEvent = trigger?.type === 'entity_event';
  const [values, setValues] = useState<Record<string, string>>({});
  const [json, setJson] = useState(FALLBACK_SAMPLE);

  // Start from the samples every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setValues(
      Object.fromEntries(
        (recordFields ?? []).map((field) => [
          field.path,
          field.path === 'email' && testerEmail ? testerEmail : field.sample ?? '',
        ]),
      ),
    );
    setJson(FALLBACK_SAMPLE);
  }, [open, recordFields, testerEmail]);

  const sampleRecord: Record<string, unknown> | null = !isEntityEvent
    ? {}
    : recordFields
      ? buildSampleRecord(values)
      : parseSampleJson(json);

  const handleRun = () => {
    if (!sampleRecord) return;
    if (!isEntityEvent) {
      onRun({ triggerType: trigger?.type, testData: {} });
      return;
    }
    onRun({
      triggerType: 'entity_event',
      // The shape the entity-event dispatcher sends (see buildTriggerData in the workflow worker).
      testData: {
        entityType: triggerField(trigger, 'entityType'),
        entityId: typeof sampleRecord.id === 'string' && sampleRecord.id ? sampleRecord.id : 'test-record',
        action: triggerField(trigger, 'eventType'),
        data: sampleRecord,
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={isRunning ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{td.title}</DialogTitle>
          <DialogDescription>{td.description}</DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div className="space-y-1 text-xs">
            <p>{td.realRunWarning}</p>
            {hasUnsavedChanges && <p className="font-medium">{td.unsavedNote}</p>}
          </div>
        </div>

        {isEntityEvent && (
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">
                {entityLabel ? td.sampleTitle.replace('{entity}', entityLabel) : td.sampleTitleGeneric}
              </p>
              <p className="text-xs text-muted-foreground">{td.sampleHint}</p>
            </div>
            {recordFields ? (
              <div className="grid max-h-[40vh] grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
                {recordFields.map((field) => (
                  <div key={field.path} className="space-y-1">
                    <Label htmlFor={`${fieldIdPrefix}-${field.path}`} className="text-xs">{field.label}</Label>
                    <Input
                      id={`${fieldIdPrefix}-${field.path}`}
                      value={values[field.path] ?? ''}
                      onChange={(e) => setValues((prev) => ({ ...prev, [field.path]: e.target.value }))}
                      className="h-8 text-sm"
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-1">
                <Label htmlFor={`${fieldIdPrefix}-json`} className="text-xs">{td.jsonLabel}</Label>
                <Textarea
                  id={`${fieldIdPrefix}-json`}
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  rows={8}
                  aria-invalid={!sampleRecord}
                  className="font-mono text-xs"
                />
                {!sampleRecord && <p className="text-xs text-destructive">{td.jsonInvalid}</p>}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isRunning}>
            {td.cancel}
          </Button>
          <Button onClick={handleRun} disabled={isRunning || !sampleRecord}>
            {isRunning && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {td.run}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
