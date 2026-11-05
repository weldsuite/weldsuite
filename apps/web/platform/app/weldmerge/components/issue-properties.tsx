import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@weldsuite/ui/components/input';
import { MultiSelect } from '@weldsuite/ui/components/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import {
  MERGE_ISSUE_PRIORITIES,
  MERGE_ISSUE_STATUSES,
  type MergeIssueDetailDto,
  type MergeIssuePriority,
  type MergeIssueStatus,
  type UpdateMergeIssueInput,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  useMergeCycles,
  useMergeIssues,
  useMergeLabels,
  useUpdateMergeIssue,
} from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { fill, formatDateRange } from '../lib/format';
import { IssueAssigneeSelect } from './issue-assignee-select';
import { IssueStatusIcon, PriorityBars } from './primitives';

const NONE = '__none__';

function Row({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * The property sidebar of an issue: status, priority, assignee, labels, cycle,
 * estimate, due date and parent. Each change is one PATCH; without
 * `merge_issues:update` the controls are read-only.
 */
export function IssueProperties({ issue, canEdit }: Readonly<{ issue: MergeIssueDetailDto; canEdit: boolean }>) {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const ti = tm.issue;
  const update = useUpdateMergeIssue();
  const labels = useMergeLabels(issue.teamId);
  const cycles = useMergeCycles(issue.teamId);
  const siblings = useMergeIssues({ teamId: issue.teamId });

  const save = (input: UpdateMergeIssueInput) => {
    update.mutate({ id: issue.id, input }, { onError: () => toast.error(ti.saveFailed) });
  };

  // Estimate and due date save on blur, so typing is not a write per keystroke.
  const [estimate, setEstimate] = useState(issue.estimate === null ? '' : String(issue.estimate));
  const [dueDate, setDueDate] = useState(issue.dueDate ?? '');
  useEffect(() => setEstimate(issue.estimate === null ? '' : String(issue.estimate)), [issue.estimate]);
  useEffect(() => setDueDate(issue.dueDate ?? ''), [issue.dueDate]);

  const parentOptions = (siblings.data ?? []).filter(
    (candidate) => candidate.id !== issue.id && candidate.parentIssueId !== issue.id,
  );

  return (
    <div className="space-y-3">
      <Row label={ti.status}>
        <Select value={issue.status} disabled={!canEdit} onValueChange={(value) => save({ status: value as MergeIssueStatus })}>
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MERGE_ISSUE_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                <span className="flex items-center gap-2">
                  <IssueStatusIcon status={status} />
                  {tm.status[status]}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <Row label={ti.priority}>
        <Select
          value={String(issue.priority)}
          disabled={!canEdit}
          onValueChange={(value) => save({ priority: Number(value) as MergeIssuePriority })}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MERGE_ISSUE_PRIORITIES.map((priority) => (
              <SelectItem key={priority} value={String(priority)}>
                <span className="flex items-center gap-2">
                  <PriorityBars priority={priority} />
                  {tm.priority[priority]}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <Row label={ti.assignee}>
        <IssueAssigneeSelect issue={issue} disabled={!canEdit} onChange={save} />
      </Row>

      <Row label={ti.labels}>
        <MultiSelect
          value={issue.labelIds}
          disabled={!canEdit}
          placeholder={ti.labelsPlaceholder}
          options={(labels.data ?? []).map((label) => ({ value: label.id, label: label.name }))}
          onChange={(labelIds) => save({ labelIds })}
        />
      </Row>

      <Row label={ti.cycle}>
        <Select
          value={issue.cycleId ?? NONE}
          disabled={!canEdit}
          onValueChange={(value) => save({ cycleId: value === NONE ? null : value })}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{ti.noCycle}</SelectItem>
            {(cycles.data ?? []).map((cycle) => (
              <SelectItem key={cycle.id} value={cycle.id}>
                {cycle.name?.trim() || fill(tm.cycles.cycleName, { number: cycle.number })} ·{' '}
                {formatDateRange(cycle.startsAt, cycle.endsAt, language)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <Row label={ti.estimate}>
        <Input
          type="number"
          min={0}
          max={1000}
          step={1}
          inputMode="numeric"
          className="h-8"
          disabled={!canEdit}
          value={estimate}
          aria-label={ti.estimate}
          onChange={(event) => setEstimate(event.target.value)}
          onBlur={() => {
            const next = estimate.trim() === '' ? null : Math.round(Number(estimate));
            if (next !== null && (Number.isNaN(next) || next < 0 || next > 1000)) {
              setEstimate(issue.estimate === null ? '' : String(issue.estimate));
              return;
            }
            if (next !== issue.estimate) save({ estimate: next });
          }}
        />
      </Row>

      <Row label={ti.dueDate}>
        <Input
          type="date"
          className="h-8"
          disabled={!canEdit}
          value={dueDate}
          aria-label={ti.dueDate}
          onChange={(event) => setDueDate(event.target.value)}
          onBlur={() => {
            const next = dueDate === '' ? null : dueDate;
            if (next !== issue.dueDate) save({ dueDate: next });
          }}
        />
      </Row>

      <Row label={ti.parent}>
        <Select
          value={issue.parentIssueId ?? NONE}
          disabled={!canEdit}
          onValueChange={(value) => save({ parentIssueId: value === NONE ? null : value })}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{ti.noParent}</SelectItem>
            {parentOptions.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.key} {candidate.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </div>
  );
}
