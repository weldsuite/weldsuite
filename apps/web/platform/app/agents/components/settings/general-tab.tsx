'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Label } from '@weldsuite/ui/components/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import {
  WORKSPACE_AGENT_MODELS,
  WORKSPACE_AGENT_POLICY_DEFAULT_MODEL,
  isWorkspaceAgentModel,
} from '@weldsuite/app-api-client/schemas/workspace-agents';
import { useAiModelOptions } from '@/hooks/queries/use-ai-settings-queries';
import { AiMetaBadge } from '@/components/ai/ai-meta-badge';
import type { AiProviderId, AiRegion } from '@weldsuite/app-api-client/schemas/ai-settings';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { useAgents, useDeleteAgent, type AgentWithRuns } from '@/hooks/queries/use-agent-queries';
import { errorMessage } from '../chat/labels';
import type { AgentForm } from './use-agent-form';

export function SettingsSection({
  title,
  description,
  children,
  className,
}: Readonly<{ title: string; description?: string; children: React.ReactNode; className?: string }>) {
  return (
    <section className={cn('space-y-3', className)}>
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function DeleteAgent({ agent }: Readonly<{ agent: AgentWithRuns }>) {
  const t = getTranslations('common').agents;
  const router = useRouter();
  const { data: agents = [] } = useAgents();
  const deleteAgent = useDeleteAgent();
  const [open, setOpen] = useState(false);

  const confirm = async () => {
    try {
      await deleteAgent.mutateAsync(agent.id);
      setOpen(false);
      const next = agents.find((a) => a.id !== agent.id);
      router.replace(next ? `/agents/${next.id}` : '/agents');
    } catch (err) {
      toast.error(errorMessage(err, t.detail.feedback.deleteFailed));
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-4 rounded-xl border border-destructive/25 p-4">
        <div>
          <p className="text-sm font-medium">{t.actions.deleteAgent}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t.deleteDialog.description}</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 text-destructive" onClick={() => setOpen(true)}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          {t.actions.delete}
        </Button>
      </div>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.deleteDialog.titleNamed.replace('{name}', agent.name)}</AlertDialogTitle>
            <AlertDialogDescription>{t.deleteDialog.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteAgent.isPending}>{t.actions.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteAgent.isPending}
              onClick={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              {t.actions.deleteAgent}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function GeneralTab({ agent, form }: Readonly<{ agent: AgentWithRuns; form: AgentForm }>) {
  const t = getTranslations('common').agents.detail.settings.general;
  const models = getTranslations('common').agents.detail.general.models;
  const { values, set } = form;
  // Kubernetes editions: the agent models this workspace may use (its enabled
  // providers), each with where it is processed, and "the workspace default"
  // (the policy's model for agents, resolved on every run). Global shows the
  // three Claude models, unlabelled.
  const policyModels = useAiModelOptions('agents');
  type Choice = { model: string; label: string; description: string; ai: { provider: AiProviderId; region: AiRegion } | null };
  const claude = (model: (typeof WORKSPACE_AGENT_MODELS)[number], ai: Choice['ai']): Choice => ({
    model,
    label: models[model].label,
    description: models[model].description,
    ai,
  });
  const pickerModels: Choice[] =
    policyModels && policyModels.length > 0
      ? [
          { model: WORKSPACE_AGENT_POLICY_DEFAULT_MODEL, label: models.default.label, description: models.default.description, ai: null },
          ...policyModels.map((m): Choice => {
            const bare = m.id.slice(m.id.indexOf('/') + 1);
            return isWorkspaceAgentModel(bare)
              ? claude(bare, { provider: m.provider, region: m.region })
              : { model: m.id, label: m.label, description: '', ai: { provider: m.provider, region: m.region } };
          }),
        ]
      : WORKSPACE_AGENT_MODELS.map((model) => claude(model, null));

  return (
    <div className="space-y-8">
      <SettingsSection title={t.identity}>
        <div className="space-y-1.5">
          <Label htmlFor="agent-name">{t.name}</Label>
          <Input id="agent-name" value={values.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-description">{t.description}</Label>
          <Input
            id="agent-description"
            value={values.description}
            placeholder={t.descriptionPlaceholder}
            onChange={(e) => set('description', e.target.value)}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t.model} description={t.modelHint}>
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t.model}>
          {pickerModels.map(({ model, label, description, ai }) => {
            const selected = values.modelId === model;
            return (
              <button
                key={model}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => set('modelId', model)}
                className={cn(
                  'rounded-xl border p-3 text-left transition-colors',
                  selected ? 'border-foreground bg-accent/60' : 'hover:border-foreground/25',
                )}
              >
                <span className="block text-sm font-medium">{label}</span>
                {description && <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>}
                {ai && <AiMetaBadge ai={ai} className="mt-2" />}
              </button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection title={t.instructions} description={t.instructionsHint}>
        <Textarea
          className="min-h-[220px] font-mono text-[13px] leading-relaxed"
          value={values.systemPrompt}
          placeholder={t.instructionsPlaceholder}
          onChange={(e) => set('systemPrompt', e.target.value)}
        />
      </SettingsSection>

      <DeleteAgent agent={agent} />
    </div>
  );
}
