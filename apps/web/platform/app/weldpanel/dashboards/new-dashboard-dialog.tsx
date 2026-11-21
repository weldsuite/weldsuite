/**
 * "New dashboard": pick a built-in template (its reports are made for you)
 * or start empty, then name it. A template's name and texts come in the
 * viewer's language.
 */

import { useEffect, useState } from 'react';
import { ArrowLeft, FilePlus2, LayoutTemplate, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { PanelDashboardTemplateDto, PanelTemplateLocale } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelVisibility } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useCreateWeldPanelDashboardFromTemplate, useWeldPanelDashboardTemplates } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';

interface NewDashboardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** "Empty dashboard": the plain create form. */
  onBlank: () => void;
}

export function NewDashboardDialog({ open, onOpenChange, projectId, onBlank }: Readonly<NewDashboardDialogProps>) {
  const { t, language, format } = useI18n();
  const tt = t.weldpanel.collab.dashboards.templates;
  const tc = t.weldpanel.analytics.common;
  const router = useRouter();
  const locale: PanelTemplateLocale = language === 'nl' ? 'nl' : 'en';
  const { data: templates, isLoading, isError, refetch } = useWeldPanelDashboardTemplates(locale, open);
  const create = useCreateWeldPanelDashboardFromTemplate();
  const [chosen, setChosen] = useState<PanelDashboardTemplateDto | null>(null);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<PanelVisibility>('private');

  useEffect(() => {
    if (open) setChosen(null);
  }, [open]);

  function choose(template: PanelDashboardTemplateDto) {
    setChosen(template);
    setName(template.name);
    setVisibility('private');
  }

  async function submit() {
    if (!chosen) return;
    try {
      const dashboard = await create.mutateAsync({ projectId, template: chosen.id, name: name.trim() || undefined, visibility, locale });
      toast.success(tt.created);
      onOpenChange(false);
      router.push(`/weldpanel/dashboards/${dashboard.id}`);
    } catch {
      toast.error(tt.failed);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (create.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{chosen ? chosen.name : tt.title}</DialogTitle>
          <DialogDescription>{chosen ? chosen.description : tt.description}</DialogDescription>
        </DialogHeader>

        {!chosen && (
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              className="flex flex-col items-start gap-1 rounded-lg border border-dashed p-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                onOpenChange(false);
                onBlank();
              }}
            >
              <FilePlus2 className="size-5 text-muted-foreground" aria-hidden />
              <span className="font-medium">{tt.blank}</span>
              <span className="text-sm text-muted-foreground">{tt.blankDescription}</span>
            </button>
            {isLoading && (
              <>
                <Skeleton className="h-28" />
                <Skeleton className="h-28" />
              </>
            )}
            {(templates ?? []).map((template) => (
              <button
                key={template.id}
                type="button"
                className="flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => choose(template)}
              >
                <LayoutTemplate className="size-5 text-primary" aria-hidden />
                <span className="font-medium">{template.name}</span>
                <span className="line-clamp-2 text-sm text-muted-foreground">{template.description}</span>
                <span className="mt-1 text-xs text-muted-foreground">{format(tt.tiles, { count: String(template.tiles.length) })}</span>
              </button>
            ))}
          </div>
        )}
        {!chosen && isError && <ErrorState message={tt.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />}

        {chosen && (
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="weldpanel-template-name">{tt.nameLabel}</Label>
              <Input id="weldpanel-template-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={255} autoComplete="off" disabled={create.isPending} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="weldpanel-template-visibility">{tt.visibilityLabel}</Label>
              <Select value={visibility} onValueChange={(value) => setVisibility(value as PanelVisibility)} disabled={create.isPending}>
                <SelectTrigger id="weldpanel-template-visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">
                    {tc.private} · {tc.privateHint}
                  </SelectItem>
                  <SelectItem value="workspace">
                    {tc.workspace} · {tc.workspaceHint}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ul className="grid gap-1 rounded-md border bg-muted/30 p-3 text-sm">
              {chosen.tiles.map((tile, index) => (
                <li key={`${tile.kind}:${tile.reportName ?? ''}:${tile.layout.x}:${tile.layout.y}`} className="flex items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">{index + 1}.</span>
                  <span className="truncate">{tile.kind === 'text' ? t.weldpanel.collab.dashboards.text.label : tile.reportName}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {chosen && (
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={() => setChosen(null)}>
              <ArrowLeft />
              {tt.back}
            </Button>
            <Button type="button" disabled={create.isPending || name.trim() === ''} onClick={() => void submit()}>
              {create.isPending && <Loader2 className="animate-spin" />}
              {create.isPending ? tt.creating : tt.use}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
