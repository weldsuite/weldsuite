/**
 * "New form": start blank (with a layout choice), from the template gallery, or
 * by describing the form to the AI. The AI tab disappears when the API answers
 * 503 `ai_unavailable`.
 */

import { useState } from 'react';
import { FilePlus2, LayoutTemplate, Loader2, MessageSquare, Rows3, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { STARTER_TEMPLATES, type FormLayout } from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { FormField } from '@weldsuite/ui/components/form-field';
import { Input } from '@weldsuite/ui/components/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { isAiUnavailable, useCreateForm, useGenerateForm } from '@/hooks/queries/use-weldforms-queries';
import { markAiUnavailable, useAiAvailable } from '../lib/ai-availability';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The folder the new form goes into (the one open on the home page). */
  folderId: string | null;
}

const LAYOUT_ICONS = { conversational: MessageSquare, classic: Rows3 } as const;

export function NewFormDialog({ open, onOpenChange, folderId }: Readonly<Props>) {
  const { t, language } = useI18n();
  const tn = t.weldforms.newForm;
  const router = useRouter();
  const create = useCreateForm();
  const generate = useGenerateForm();
  const aiAvailable = useAiAvailable();
  const locale = language === 'nl' ? 'nl' : 'en';

  const [tab, setTab] = useState<'blank' | 'template' | 'ai'>('blank');
  const [title, setTitle] = useState('');
  const [layout, setLayout] = useState<FormLayout>('conversational');
  const [category, setCategory] = useState<string>('all');
  const [prompt, setPrompt] = useState('');

  const categories = t.weldforms.templateCategories as Record<string, string>;
  const templates = STARTER_TEMPLATES.filter((tpl) => category === 'all' || tpl.category === category);
  const usedCategories = Array.from(new Set(STARTER_TEMPLATES.map((tpl) => tpl.category)));

  function done(id: string) {
    onOpenChange(false);
    setTitle('');
    setPrompt('');
    router.push(`/weldforms/${id}/edit`);
  }

  async function createBlank() {
    try {
      const form = await create.mutateAsync({ title: title.trim() || tn.untitled, folderId, layout });
      done(form.data.id);
    } catch {
      toast.error(tn.createFailed);
    }
  }

  async function fromTemplate(templateId: string, templateName: string) {
    try {
      const form = await create.mutateAsync({ title: title.trim() || templateName, folderId, templateId });
      done(form.data.id);
    } catch {
      toast.error(tn.createFailed);
    }
  }

  async function fromAi() {
    try {
      const result = await generate.mutateAsync({ prompt: prompt.trim(), layout, language: locale });
      const form = await create.mutateAsync({ title: title.trim() || result.title || tn.untitled, folderId, definition: result.definition });
      done(form.data.id);
    } catch (err) {
      if (isAiUnavailable(err)) {
        markAiUnavailable();
        setTab('blank');
        toast.info(tn.aiUnavailable);
      } else {
        toast.error(tn.aiFailed);
      }
    }
  }

  const busy = create.isPending || generate.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tn.title}</DialogTitle>
          <DialogDescription>{tn.description}</DialogDescription>
        </DialogHeader>

        <FormField label={tn.name}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tn.namePlaceholder} maxLength={255} autoFocus />
        </FormField>

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="blank">
              <FilePlus2 className="size-4" />
              {tn.blank}
            </TabsTrigger>
            <TabsTrigger value="template">
              <LayoutTemplate className="size-4" />
              {tn.template}
            </TabsTrigger>
            {aiAvailable && (
              <TabsTrigger value="ai">
                <Sparkles className="size-4" />
                {tn.ai}
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="blank" className="mt-4 space-y-4">
            <LayoutChoice value={layout} onChange={setLayout} />
            <DialogFooter>
              <Button type="button" onClick={() => void createBlank()} disabled={busy}>
                {create.isPending && <Loader2 className="size-4 animate-spin" />}
                {t.common.actions.create}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="template" className="mt-4 space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {['all', ...usedCategories].map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCategory(id)}
                  className={cn('rounded-full border px-3 py-1 text-xs', category === id ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent/60')}
                >
                  {id === 'all' ? tn.allCategories : categories[id]}
                </button>
              ))}
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {templates.map((tpl) => (
                <li key={tpl.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void fromTemplate(tpl.id, tpl.name[locale])}
                    className="flex h-full w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent/40 disabled:opacity-60"
                  >
                    <span className="text-sm font-medium">{tpl.name[locale]}</span>
                    <span className="text-xs text-muted-foreground">{tpl.description[locale]}</span>
                    <span className="mt-auto pt-1 text-[11px] uppercase tracking-wide text-muted-foreground/80">{categories[tpl.category]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </TabsContent>

          {aiAvailable && (
            <TabsContent value="ai" className="mt-4 space-y-4">
              <FormField label={tn.aiPrompt} helpText={tn.aiHelp}>
                <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} maxLength={2000} placeholder={tn.aiPlaceholder} />
              </FormField>
              <LayoutChoice value={layout} onChange={setLayout} />
              <DialogFooter>
                <Button type="button" onClick={() => void fromAi()} disabled={busy || prompt.trim().length < 10}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  {busy ? tn.aiWorking : tn.aiGenerate}
                </Button>
              </DialogFooter>
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function LayoutChoice({ value, onChange }: Readonly<{ value: FormLayout; onChange: (layout: FormLayout) => void }>) {
  const { t } = useI18n();
  const tn = t.weldforms.newForm;
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-medium">{tn.layout}</legend>
      {(['conversational', 'classic'] as const).map((layout) => {
        const Icon = LAYOUT_ICONS[layout];
        return (
          <label key={layout} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50', value === layout ? 'border-primary bg-primary/5' : 'hover:bg-accent/40')}>
            <input type="radio" name="new-form-layout" value={layout} checked={value === layout} onChange={() => onChange(layout)} className="sr-only" />
            <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              <span className="block text-sm font-medium">{tn.layouts[layout].label}</span>
              <span className="block text-xs text-muted-foreground">{tn.layouts[layout].description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
