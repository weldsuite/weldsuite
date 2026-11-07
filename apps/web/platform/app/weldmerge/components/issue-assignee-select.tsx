import { Bot } from 'lucide-react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { UpdateMergeIssueInput } from '@weldsuite/app-api-client/schemas/weldmerge';
import { useAgents } from '@/hooks/queries/use-agent-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useMergeMembers } from '../lib/use-members';
import { assigneePatch, assigneeValue, NO_ASSIGNEE } from './assignee-lib';

/**
 * The assignee of an issue: a workspace member, or a WeldAgent agent that picks
 * the issue up as its task. Choosing one clears the other.
 */
export function IssueAssigneeSelect({
  issue,
  disabled,
  onChange,
}: Readonly<{
  issue: { assigneeUserId: string | null; agentId: string | null };
  disabled?: boolean;
  onChange: (patch: UpdateMergeIssueInput) => void;
}>) {
  const { t } = useI18n();
  const ta = t.weldmerge.across.issue.agent;
  const { members } = useMergeMembers();
  const agents = useAgents({ status: 'active' });
  const agentRows = agents.data ?? [];

  const current = assigneeValue(issue);
  // An assigned agent that is no longer active (paused, deleted) still has to show.
  const knownAgent = issue.agentId ? agentRows.some((agent) => agent.id === issue.agentId) : true;

  return (
    <div className="space-y-1">
      <Select value={current} disabled={disabled} onValueChange={(value) => onChange(assigneePatch(value))}>
        <SelectTrigger size="sm" className="w-full" aria-label={t.weldmerge.issue.assignee}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_ASSIGNEE}>{t.weldmerge.unassigned}</SelectItem>
          <SelectGroup>
            <SelectLabel>{ta.groupMembers}</SelectLabel>
            {members.map((member) => (
              <SelectItem key={member.userId} value={`user:${member.userId}`}>
                {member.name}
              </SelectItem>
            ))}
          </SelectGroup>
          {(agentRows.length > 0 || !knownAgent) && (
            <SelectGroup>
              <SelectLabel>{ta.groupAgents}</SelectLabel>
              {agentRows.map((agent) => (
                <SelectItem key={agent.id} value={`agent:${agent.id}`}>
                  <span className="flex items-center gap-2">
                    <Bot className="size-3.5 text-muted-foreground" />
                    {agent.name}
                  </span>
                </SelectItem>
              ))}
              {!knownAgent && issue.agentId && (
                <SelectItem value={`agent:${issue.agentId}`}>
                  <span className="flex items-center gap-2">
                    <Bot className="size-3.5 text-muted-foreground" />
                    {issue.agentId}
                  </span>
                </SelectItem>
              )}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      {issue.agentId && <p className="text-xs text-muted-foreground">{ta.agentHint}</p>}
    </div>
  );
}
