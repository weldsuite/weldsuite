/**
 * "From template" on the WeldSign home: pick a template (with search), then say
 * who fills each role. Hidden for a member who may not read templates or make
 * requests, and while the workspace has no template.
 */

import { useDeferredValue, useState } from 'react';
import { LayoutTemplate, Loader2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import type { SignTemplateSummary } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { useSignTemplates } from '@/hooks/queries/use-weldsign-queries';
import { canUseTemplate } from '../lib/use-template';
import { RoleChips } from './role-chips';
import { UseTemplateDialog } from './use-template-dialog';

export function FromTemplateButton() {
  const { t } = useI18n();
  const canReadTemplates = useCan('sign_templates:read');
  const canCreateRequests = useCan('sign_envelopes:create');
  const enabled = canReadTemplates && canCreateRequests;
  const { templates } = useSignTemplates('', enabled);
  const [picking, setPicking] = useState(false);
  const [usingId, setUsingId] = useState<string | null>(null);

  if (!enabled || templates.length === 0) return null;

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
        <LayoutTemplate />
        {t.weldsign.templates.picker.action}
      </Button>
      {picking && (
        <TemplatePicker
          onClose={() => setPicking(false)}
          onPick={(id) => {
            setPicking(false);
            setUsingId(id);
          }}
        />
      )}
      <UseTemplateDialog templateId={usingId} onClose={() => setUsingId(null)} />
    </>
  );
}

function TemplatePicker({ onPick, onClose }: Readonly<{ onPick: (templateId: string) => void; onClose: () => void }>) {
  const { t } = useI18n();
  const tp = t.weldsign.templates.picker;
  const [search, setSearch] = useState('');
  const query = useSignTemplates(useDeferredValue(search.trim()));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{tp.title}</DialogTitle>
          <DialogDescription>{tp.description}</DialogDescription>
        </DialogHeader>
        <Input
          type="search"
          aria-label={tp.searchPlaceholder}
          placeholder={tp.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <PickerList
          templates={query.templates}
          isLoading={query.isLoading}
          failed={query.isError}
          hasMore={query.hasNextPage}
          loadingMore={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
          onPick={onPick}
        />
      </DialogContent>
    </Dialog>
  );
}

interface PickerListProps {
  templates: SignTemplateSummary[];
  isLoading: boolean;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onPick: (templateId: string) => void;
}

function PickerList({ templates, isLoading, failed, hasMore, loadingMore, onLoadMore, onPick }: Readonly<PickerListProps>) {
  const { t, format } = useI18n();
  const tp = t.weldsign.templates.picker;

  if (isLoading) {
    return (
      <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {tp.loading}
      </p>
    );
  }
  if (failed) return <p className="py-6 text-center text-sm text-destructive">{tp.loadFailed}</p>;
  if (templates.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{tp.empty}</p>;

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex max-h-[50dvh] flex-col gap-2 overflow-y-auto">
        {templates.map((template) => (
          <li key={template.id}>
            <button
              type="button"
              disabled={!canUseTemplate(template)}
              title={canUseTemplate(template) ? undefined : t.weldsign.templates.cannotUse}
              onClick={() => onPick(template.id)}
              className="flex w-full flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
            >
              <span className="font-medium">{template.title}</span>
              <RoleChips roles={template.roles} />
              <span className="text-xs text-muted-foreground">
                {format(template.documentCount === 1 ? t.weldsign.home.documentCount : t.weldsign.home.documentCountPlural, { count: template.documentCount })}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hasMore && (
        <Button variant="ghost" size="sm" disabled={loadingMore} onClick={onLoadMore}>
          {tp.loadMore}
        </Button>
      )}
    </div>
  );
}
