'use client';

import { useMemo } from 'react';
import { toast } from 'sonner';
import { Globe, Lock, Users, type LucideIcon } from 'lucide-react';
import { MultiSelect } from '@weldsuite/ui/components/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import type { WorkspaceAgentVisibility } from '@weldsuite/app-api-client/schemas/workspace-agents';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import {
  useAgents,
  useUpdateAgentAccess,
  useUpdateAgentSubagents,
  type AgentWithRuns,
} from '@/hooks/queries/use-agent-queries';
import { useAllTeamMembers } from '@/hooks/queries/use-team-queries';
import { errorMessage } from '../chat/labels';
import { SettingsSection } from './general-tab';

const VISIBILITY_ICONS: Record<WorkspaceAgentVisibility, LucideIcon> = {
  private: Lock,
  members: Users,
  workspace: Globe,
};

function VisibilityOption({
  value,
  selected,
  disabled,
  onSelect,
}: Readonly<{
  value: WorkspaceAgentVisibility;
  selected: boolean;
  disabled: boolean;
  onSelect: (value: WorkspaceAgentVisibility) => void;
}>) {
  const t = getTranslations('common').agents.detail.settings.team.visibility[value];
  const Icon = VISIBILITY_ICONS[value];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={() => onSelect(value)}
      className={cn(
        'flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors',
        selected ? 'border-foreground' : 'hover:bg-accent/40',
        disabled && 'cursor-default opacity-70 hover:bg-transparent',
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{t.title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{t.description}</span>
      </span>
    </button>
  );
}

/**
 * Who the agent works with, like a teammate: its owner (who changes it and
 * gets its approvals), who may use it, and the agents it hands work to.
 */
export function TeamTab({ agent }: Readonly<{ agent: AgentWithRuns }>) {
  const t = getTranslations('common').agents.detail.settings.team;
  const canEdit = agent.capabilities?.canEdit ?? false;
  const { data: members } = useAllTeamMembers({ status: 'ACTIVE' });
  const { data: agents = [] } = useAgents();
  const updateAccess = useUpdateAgentAccess(agent.id);
  const updateSubagents = useUpdateAgentSubagents(agent.id);

  const people = useMemo(
    () =>
      (members ?? []).map((m) => ({
        value: m.userId,
        label: m.name || m.userId,
      })),
    [members],
  );
  const nameOf = (userId: string | null) => people.find((p) => p.value === userId)?.label ?? t.unknownPerson;

  const otherAgents = useMemo(
    () => agents.filter((a) => a.id !== agent.id).map((a) => ({ value: a.id, label: a.name })),
    [agents, agent.id],
  );

  const saveAccess = async (data: Parameters<typeof updateAccess.mutateAsync>[0]) => {
    try {
      await updateAccess.mutateAsync(data);
      toast.success(t.saved);
    } catch (err) {
      toast.error(errorMessage(err, t.saveFailed));
    }
  };

  const saveSubagents = async (subagentIds: string[], delegateToSelf: boolean) => {
    try {
      await updateSubagents.mutateAsync({ subagentIds, delegateToSelf });
      toast.success(t.saved);
    } catch (err) {
      toast.error(errorMessage(err, t.saveFailed));
    }
  };

  const busy = updateAccess.isPending || updateSubagents.isPending;
  const locked = !canEdit || busy;

  return (
    <div className="space-y-8">
      {!canEdit && <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{t.readOnly}</p>}

      <SettingsSection title={t.ownerTitle} description={t.ownerDescription}>
        {canEdit ? (
          <Select
            value={agent.ownerId ?? undefined}
            disabled={locked}
            onValueChange={(ownerId) => void saveAccess({ ownerId })}
          >
            <SelectTrigger className="h-9 w-full">
              <SelectValue placeholder={t.noOwner} />
            </SelectTrigger>
            <SelectContent>
              {people.map((person) => (
                <SelectItem key={person.value} value={person.value}>
                  {person.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-sm">{agent.ownerId ? nameOf(agent.ownerId) : t.noOwner}</p>
        )}
      </SettingsSection>

      <SettingsSection title={t.visibilityTitle} description={t.visibilityDescription}>
        <div role="radiogroup" className="space-y-2">
          {(['private', 'members', 'workspace'] as const).map((value) => (
            <VisibilityOption
              key={value}
              value={value}
              selected={agent.visibility === value}
              disabled={locked}
              onSelect={(visibility) => {
                if (visibility !== agent.visibility) void saveAccess({ visibility });
              }}
            />
          ))}
        </div>
        {agent.visibility === 'members' && (
          <MultiSelect
            options={people.filter((p) => p.value !== agent.ownerId)}
            value={agent.memberIds ?? []}
            onChange={(memberIds) => void saveAccess({ memberIds })}
            placeholder={t.membersPlaceholder}
            searchPlaceholder={t.searchPeople}
            emptyText={t.noPeople}
            disabled={locked}
            aria-label={t.membersPlaceholder}
          />
        )}
      </SettingsSection>

      <SettingsSection title={t.subagentsTitle} description={t.subagentsDescription}>
        <MultiSelect
          options={otherAgents}
          value={agent.subagentIds}
          onChange={(subagentIds) => void saveSubagents(subagentIds, agent.delegateToSelf)}
          placeholder={t.subagentsPlaceholder}
          searchPlaceholder={t.searchAgents}
          emptyText={t.noAgents}
          disabled={locked}
          aria-label={t.subagentsPlaceholder}
        />
        <label className="flex items-start gap-3 rounded-xl border p-3.5">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t.selfTitle}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{t.selfDescription}</span>
          </span>
          <Switch
            checked={agent.delegateToSelf}
            disabled={locked}
            onCheckedChange={(on) => void saveSubagents(agent.subagentIds, on)}
            className="mt-1"
          />
        </label>
        <p className="text-xs text-muted-foreground">{t.subagentsNote}</p>
      </SettingsSection>
    </div>
  );
}
