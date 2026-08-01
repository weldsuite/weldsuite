import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  ENRICHMENT_ACTIONS,
  EMAIL_FINDER_PROVIDERS,
  type EmailFinderProvider,
  type EnrichmentActionType,
  type WelddataColumn,
} from '@weldsuite/app-api-client/schemas/welddata';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  useCreateColumn,
  useUpdateColumn,
} from '@/hooks/queries/use-welddata-queries';
import { AiUnavailable } from '@/components/ai/ai-unavailable';

// AI has been removed platform-wide — the 'ai' enrichment action (LLM
// column generation via PROMPT_PRESETS) is no longer offered for new
// columns. Existing 'ai' columns can still be viewed/renamed; see the
// `actionType === 'ai'` branch below.
const NON_AI_ENRICHMENT_ACTIONS = ENRICHMENT_ACTIONS.filter((a) => a.type !== 'ai');

interface AddColumnDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listId: string;
  /** When set, the dialog edits this column instead of creating one. */
  column?: WelddataColumn | null;
  /** The list's kind — filters which preset prompts are offered. */
  leadKind?: 'person' | 'company';
}

export function AddColumnDialog({ open, onOpenChange, listId, column }: AddColumnDialogProps) {
  const t = useTranslations();
  const createColumn = useCreateColumn();
  const updateColumn = useUpdateColumn();

  const [name, setName] = useState('');
  const [actionType, setActionType] = useState<EnrichmentActionType>('email_finder');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>('__default');
  const [webSearch, setWebSearch] = useState(false);
  const [provider, setProvider] = useState<EmailFinderProvider>('findymail');

  // Hydrate when opening / switching target column.
  useEffect(() => {
    if (!open) return;
    if (column) {
      setName(column.name);
      setActionType(column.type);
      if (column.config.type === 'ai') {
        setPrompt(column.config.prompt ?? '');
        setModel(column.config.model ?? '__default');
        setWebSearch(!!column.config.webSearch);
      } else if (column.config.type === 'email_finder') {
        setProvider(column.config.provider);
      } else if (column.config.type === 'phone_finder') {
        setWebSearch(!!column.config.webSearchFallback);
      }
    } else {
      setName('');
      setActionType('email_finder');
      setPrompt('');
      setModel('__default');
      setWebSearch(false);
      setProvider('findymail');
    }
  }, [open, column]);

  const busy = createColumn.isPending || updateColumn.isPending;
  // AI columns can only be renamed now (no new AI columns, no re-running the
  // prompt), so the prompt is no longer a save precondition.
  const canSave = name.trim().length > 0;

  async function handleSave() {
    if (!canSave) return;
    const config =
      actionType === 'email_finder'
        ? { type: 'email_finder' as const, provider }
        : actionType === 'phone_finder'
          ? {
              type: 'phone_finder' as const,
              source: 'website' as const,
              webSearchFallback: webSearch || undefined,
            }
          : {
              type: 'ai' as const,
              prompt: prompt.trim(),
              model: model === '__default' ? undefined : model,
              webSearch: webSearch || undefined,
            };
    try {
      if (column) {
        await updateColumn.mutateAsync({ id: column.id, listId, data: { name: name.trim(), config } });
        toast.success(t('welddata.toasts.columnUpdated'));
      } else {
        await createColumn.mutateAsync({ listId, data: { name: name.trim(), config } });
        toast.success(t('welddata.toasts.columnCreated'));
      }
      onOpenChange(false);
    } catch {
      toast.error(t('welddata.toasts.runFailed'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {column ? t('welddata.enrich.editColumnTitle') : t('welddata.enrich.addColumnTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="col-name">{t('welddata.enrich.columnName')}</Label>
            <Input
              id="col-name"
              value={name}
              placeholder={t('welddata.enrich.columnNamePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('welddata.enrich.actionType')}</Label>
            <Select
              value={actionType}
              onValueChange={(v) => setActionType(v as EnrichmentActionType)}
              disabled={!!column}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* 'ai' is only ever shown here when editing a pre-existing AI
                    column (the Select is `disabled` in that case) — it's never
                    offered as a choice for new columns. */}
                {(column?.type === 'ai' ? ENRICHMENT_ACTIONS : NON_AI_ENRICHMENT_ACTIONS).map((a) => (
                  <SelectItem key={a.type} value={a.type}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {actionType === 'ai' && (
            <>
              <AiUnavailable variant="inline" />
              <div className="space-y-1.5">
                <Label htmlFor="col-prompt">{t('welddata.enrich.prompt')}</Label>
                <Textarea
                  id="col-prompt"
                  value={prompt}
                  rows={5}
                  disabled
                  className="opacity-70"
                />
                <p className="text-xs text-muted-foreground">{t('welddata.enrich.promptHint')}</p>
              </div>
            </>
          )}

          {actionType === 'email_finder' && (
            <div className="space-y-1.5">
              <Label>{t('welddata.enrich.provider')}</Label>
              <Select value={provider} onValueChange={(v) => setProvider(v as EmailFinderProvider)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMAIL_FINDER_PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p} className="capitalize">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('welddata.enrich.emailFinderHint')}</p>
            </div>
          )}

          {actionType === 'phone_finder' && (
            <>
              <div className="rounded-md border p-3">
                <p className="text-sm font-medium">{t('welddata.enrich.phoneFinderTitle')}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('welddata.enrich.phoneFinderHint')}
                </p>
              </div>

              <label className="flex items-start gap-2 rounded-md border p-3 cursor-pointer">
                <Checkbox
                  checked={webSearch}
                  onCheckedChange={(c) => setWebSearch(!!c)}
                  className="mt-0.5"
                />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">
                    {t('welddata.enrich.phoneFinderWebFallback')}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t('welddata.enrich.phoneFinderWebFallbackHint')}
                  </span>
                </span>
              </label>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.actions.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!canSave || busy}>
            {column ? t('welddata.enrich.save') : t('welddata.enrich.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
