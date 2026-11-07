import { useId, type ReactNode } from 'react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { VariableGroup } from '@weldsuite/ui/components/workflow-canvas/parts/variable-picker';
import { MERGE_ISSUE_PRIORITIES, MERGE_ISSUE_STATUSES } from '@weldsuite/app-api-client/schemas/weldmerge';
import { useMergeTeams } from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { FormFieldIdProvider } from '../lib/editor-field-context';
import { VariableInput } from './localized-variable-input';

/** Props every step form of the editor receives (see `VARIABLE_STEP_FORMS` in action-config-form.tsx). */
export interface MergeStepFormProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  triggerType?: string;
  steps?: Array<{ id: string; name: string; type: string }>;
  workflowVariables?: Array<{ name: string; type?: string }>;
  extraVariableGroups?: VariableGroup[];
  excludeGroups?: string[];
}

const KEEP = '__keep__';

function Field({ label, description, required, children }: Readonly<{ label: string; description?: string; required?: boolean; children: ReactNode }>) {
  const fieldId = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={fieldId} className="flex items-center gap-1 text-xs">
        {label}
        {required && <span className="text-red-500">*</span>}
      </Label>
      <FormFieldIdProvider value={fieldId}>{children}</FormFieldIdProvider>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

/** Reads a string config value. */
function text(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Sets an optional text field, or removes the key when it is emptied: the merge
 * intake rejects an empty title, and an empty assignee would be stored as ''.
 */
function withOptionalText(config: Record<string, unknown>, key: string, value: string): Record<string, unknown> {
  const next = { ...config };
  if (value.trim() === '') delete next[key];
  else next[key] = value;
  return next;
}

/** Status and priority pickers shared by create and update; `optional` adds a "keep as is" choice. */
function StatusAndPriority({
  config,
  onChange,
  optional,
}: Readonly<{ config: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void; optional: boolean }>) {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const tc = tm.across.connect;
  const status = text(config, 'status');
  const priority = config.priority === undefined || config.priority === null ? '' : String(config.priority);
  const setOrClear = (key: 'status' | 'priority', value: string) => {
    const next = { ...config };
    if (value === KEEP) delete next[key];
    else next[key] = key === 'priority' ? Number(value) : value;
    onChange(next);
  };
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label={tc.status}>
        <Select value={status || (optional ? KEEP : 'backlog')} onValueChange={(value) => setOrClear('status', value)}>
          <SelectTrigger aria-label={tc.status}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {optional && <SelectItem value={KEEP}>{tc.keep}</SelectItem>}
            {MERGE_ISSUE_STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {tm.status[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={tc.priority}>
        <Select value={priority || (optional ? KEEP : '0')} onValueChange={(value) => setOrClear('priority', value)}>
          <SelectTrigger aria-label={tc.priority}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {optional && <SelectItem value={KEEP}>{tc.keep}</SelectItem>}
            {MERGE_ISSUE_PRIORITIES.map((value) => (
              <SelectItem key={value} value={String(value)}>
                {tm.priority[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

/** `merge.create_issue`: a WeldMerge issue in a team, created as the workflow's owner. */
export function MergeCreateIssueForm({ config, onChange, triggerType, steps = [], workflowVariables = [], extraVariableGroups, excludeGroups }: Readonly<MergeStepFormProps>) {
  const { t } = useI18n();
  const tc = t.weldmerge.across.connect;
  const teams = useMergeTeams();
  const variableProps = { triggerType, steps, workflowVariables, extraVariableGroups, excludeGroups };
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{tc.variablesHint}</p>
      <Field label={tc.team} required>
        <Select value={text(config, 'teamId')} onValueChange={(value) => onChange({ ...config, teamId: value })}>
          <SelectTrigger aria-label={tc.team}>
            <SelectValue placeholder={tc.selectTeam} />
          </SelectTrigger>
          <SelectContent>
            {(teams.data ?? []).map((team) => (
              <SelectItem key={team.id} value={team.id}>
                {team.name} ({team.key})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {teams.isSuccess && teams.data.length === 0 && <p className="mt-1 text-xs text-muted-foreground">{tc.noTeams}</p>}
      </Field>
      <Field label={tc.issueTitle} required>
        <VariableInput
          value={text(config, 'title')}
          onChange={(value) => onChange({ ...config, title: value })}
          placeholder={tc.issueTitlePlaceholder}
          {...variableProps}
        />
      </Field>
      <Field label={tc.issueDescription}>
        <VariableInput
          value={text(config, 'description')}
          onChange={(value) => onChange(withOptionalText(config, 'description', value))}
          placeholder={tc.issueDescriptionPlaceholder}
          multiline
          rows={3}
          {...variableProps}
        />
      </Field>
      <StatusAndPriority config={config} onChange={onChange} optional={false} />
      <Field label={tc.assignee}>
        <VariableInput
          value={text(config, 'assigneeUserId')}
          onChange={(value) => onChange(withOptionalText(config, 'assigneeUserId', value))}
          placeholder={tc.assigneePlaceholder}
          {...variableProps}
        />
      </Field>
    </div>
  );
}

/** `merge.update_issue`: change an issue by key or id; fields left on "keep as is" are not touched. */
export function MergeUpdateIssueForm({ config, onChange, triggerType, steps = [], workflowVariables = [], extraVariableGroups, excludeGroups }: Readonly<MergeStepFormProps>) {
  const { t } = useI18n();
  const tc = t.weldmerge.across.connect;
  const variableProps = { triggerType, steps, workflowVariables, extraVariableGroups, excludeGroups };
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{tc.variablesHint}</p>
      <Field label={tc.issue} required description={tc.issueDesc}>
        <VariableInput
          value={text(config, 'issue')}
          onChange={(value) => onChange({ ...config, issue: value })}
          placeholder={tc.issuePlaceholder}
          {...variableProps}
        />
      </Field>
      <Field label={tc.issueTitle}>
        <VariableInput
          value={text(config, 'title')}
          onChange={(value) => onChange(withOptionalText(config, 'title', value))}
          placeholder={tc.issueTitlePlaceholder}
          {...variableProps}
        />
      </Field>
      <StatusAndPriority config={config} onChange={onChange} optional />
      <Field label={tc.assignee}>
        <VariableInput
          value={text(config, 'assigneeUserId')}
          onChange={(value) => onChange(withOptionalText(config, 'assigneeUserId', value))}
          placeholder={tc.assigneePlaceholder}
          {...variableProps}
        />
      </Field>
    </div>
  );
}

/** `merge.comment_on_issue`: add a comment to an issue by key or id. */
export function MergeCommentForm({ config, onChange, triggerType, steps = [], workflowVariables = [], extraVariableGroups, excludeGroups }: Readonly<MergeStepFormProps>) {
  const { t } = useI18n();
  const tc = t.weldmerge.across.connect;
  const variableProps = { triggerType, steps, workflowVariables, extraVariableGroups, excludeGroups };
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{tc.variablesHint}</p>
      <Field label={tc.issue} required description={tc.issueDesc}>
        <VariableInput
          value={text(config, 'issue')}
          onChange={(value) => onChange({ ...config, issue: value })}
          placeholder={tc.issuePlaceholder}
          {...variableProps}
        />
      </Field>
      <Field label={tc.comment} required>
        <VariableInput
          value={text(config, 'body')}
          onChange={(value) => onChange({ ...config, body: value })}
          placeholder={tc.commentPlaceholder}
          multiline
          rows={4}
          {...variableProps}
        />
      </Field>
    </div>
  );
}
