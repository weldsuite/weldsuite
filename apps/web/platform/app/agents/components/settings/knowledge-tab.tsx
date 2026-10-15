'use client';

import { useState } from 'react';
import { BookOpen, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { getTranslations } from '@/lib/i18n';
import {
  useAgentMemories,
  useAgentSkills,
  useCreateAgentMemory,
  useCreateAgentSkill,
  useDeleteAgentMemory,
  useDisableAgentSkill,
} from '@/hooks/queries/use-agent-parity-queries';
import { errorMessage } from '../chat/labels';
import { SettingsSection } from './general-tab';

function Skills({ agentId }: Readonly<{ agentId: string }>) {
  const t = getTranslations('common').agents.detail.parity;
  const skills = useAgentSkills(agentId);
  const create = useCreateAgentSkill(agentId);
  const disable = useDisableAgentSkill(agentId);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const valid = name.trim().length >= 2 && instructions.trim().length >= 20;
  const list = skills.data ?? [];

  const save = async () => {
    try {
      await create.mutateAsync({ name: name.trim(), instructions: instructions.trim() });
      setName('');
      setInstructions('');
      setAdding(false);
      toast.success(t.skills.saved);
    } catch (err) {
      toast.error(errorMessage(err, t.actionFailed));
    }
  };

  return (
    <SettingsSection title={t.skills.title} description={t.skills.hint}>
      {skills.isError && <p className="text-xs text-destructive">{t.loadFailed}</p>}
      {!skills.isLoading && list.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">{t.skills.empty}</p>
      )}
      <div className="space-y-1.5">
        {list.map((skill) => (
          <div key={skill.id} className="group flex items-center gap-2.5 rounded-lg border px-3 py-2">
            <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">{skill.name}</span>
            <button
              type="button"
              aria-label={t.skills.disable}
              title={t.skills.disable}
              disabled={disable.isPending}
              onClick={() => disable.mutate(skill.id, { onError: (err) => toast.error(errorMessage(err, t.actionFailed)) })}
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      {adding ? (
        <div className="space-y-2 rounded-xl border bg-muted/30 p-3.5">
          <Input placeholder={t.skills.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Textarea
            placeholder={t.skills.instructionsPlaceholder}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={4}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {getTranslations('common').agents.actions.cancel}
            </Button>
            <Button size="sm" disabled={!valid || create.isPending} onClick={() => void save()}>
              {t.skills.save}
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" />
          {t.skills.add}
        </Button>
      )}
    </SettingsSection>
  );
}

function Memory({ agentId }: Readonly<{ agentId: string }>) {
  const t = getTranslations('common').agents.detail.parity;
  const memories = useAgentMemories(agentId);
  const create = useCreateAgentMemory(agentId);
  const remove = useDeleteAgentMemory(agentId);
  const [content, setContent] = useState('');
  const list = memories.data ?? [];
  const onError = (err: unknown) => toast.error(errorMessage(err, t.actionFailed));

  const save = () => {
    const text = content.trim();
    if (!text) return;
    create.mutate(text, { onSuccess: () => setContent(''), onError });
  };

  return (
    <SettingsSection title={t.memory.title} description={t.memory.hint}>
      {memories.isError && <p className="text-xs text-destructive">{t.loadFailed}</p>}
      {list.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {list.map((memory) => (
            <li key={memory.id} className="group flex items-start gap-2 px-3 py-2.5 text-sm">
              <span className="min-w-0 flex-1 leading-relaxed">{memory.content}</span>
              <button
                type="button"
                aria-label={t.memory.delete}
                title={t.memory.delete}
                disabled={remove.isPending}
                onClick={() => remove.mutate(memory.id, { onError })}
                className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!memories.isLoading && list.length === 0 && <p className="text-sm text-muted-foreground">{t.memory.empty}</p>}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input placeholder={t.memory.placeholder} value={content} onChange={(e) => setContent(e.target.value)} />
        <Button type="submit" size="sm" className="h-9 shrink-0" disabled={!content.trim() || create.isPending}>
          {t.memory.save}
        </Button>
      </form>
    </SettingsSection>
  );
}

export function KnowledgeTab({ agentId }: Readonly<{ agentId: string }>) {
  return (
    <div className="space-y-8">
      <Skills agentId={agentId} />
      <Memory agentId={agentId} />
    </div>
  );
}
