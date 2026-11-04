import { AlertCircle, Copy, Lock, Search } from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import type { ProjectTemplate } from '@weldsuite/app-api-client/schemas/project-closing';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { templateWeeks } from '../_lib/template';

interface TemplateGalleryProps {
  templates: readonly ProjectTemplate[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  search: string;
  onSearchChange: (search: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  canManage: boolean;
  onSaveProject: () => void;
}

function TemplateCard({ template, selected, onSelect }: Readonly<{ template: ProjectTemplate; selected: boolean; onSelect: () => void }>) {
  const { t, plural } = useI18n();
  const copy = t.flowClosing.templates.gallery;
  const meta = [
    plural(templateWeeks(template.summary.durationDays), copy.meta.weeks),
    plural(template.summary.tasks, copy.meta.tasks),
    template.usageCount === 0 ? copy.meta.neverUsed : plural(template.usageCount, copy.meta.used),
  ].join(' · ');
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-left outline-none transition-colors',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
        selected ? 'border-foreground ring-1 ring-foreground' : 'hover:bg-accent/50',
      )}
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        <span className="min-w-0 truncate">{template.name}</span>
        <span className="shrink-0 rounded-md bg-muted px-1.5 text-[11px] font-medium text-foreground/80">
          {template.shared ? copy.badge.shared : copy.badge.private}
        </span>
      </span>
      {template.description ? <span className="line-clamp-2 text-xs text-muted-foreground">{template.description}</span> : null}
      <span className="text-xs text-muted-foreground">{meta}</span>
    </button>
  );
}

function GalleryError({ forbidden, onRetry }: Readonly<{ forbidden: boolean; onRetry: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowClosing.templates.gallery;
  const Icon = forbidden ? Lock : AlertCircle;
  return (
    <div role="alert" className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center">
      <Icon aria-hidden className="size-5 text-muted-foreground" />
      <p className="text-sm font-semibold">{forbidden ? copy.forbiddenTitle : copy.errorTitle}</p>
      <p className="text-xs text-muted-foreground">{forbidden ? copy.forbiddenDescription : copy.errorDescription}</p>
      {forbidden ? null : (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t.flowClosing.shared.retry}
        </Button>
      )}
    </div>
  );
}

function GalleryEmpty({ searching, canManage }: Readonly<{ searching: boolean; canManage: boolean }>) {
  const { t } = useI18n();
  const copy = t.flowClosing.templates.gallery;
  const emptyDescription = canManage ? copy.emptyManage : copy.emptyMember;
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center">
      <p className="text-sm font-semibold">{searching ? copy.noMatchTitle : copy.emptyTitle}</p>
      <p className="text-xs text-muted-foreground">{searching ? copy.noMatchDescription : emptyDescription}</p>
    </div>
  );
}

/** The templates this person may use, with a search box and the "save a project" entry. */
export function TemplateGallery({
  templates,
  isLoading,
  error,
  onRetry,
  search,
  onSearchChange,
  selectedId,
  onSelect,
  canManage,
  onSaveProject,
}: Readonly<TemplateGalleryProps>) {
  const { t, format } = useI18n();
  const copy = t.flowClosing.templates.gallery;

  let body;
  if (isLoading) {
    body = (
      <div role="status" aria-busy="true" aria-label={copy.loadingLabel} className="flex flex-col gap-2">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-20 rounded-xl" />
        ))}
      </div>
    );
  } else if (error) {
    body = <GalleryError forbidden={isApiError(error) && error.status === 403} onRetry={onRetry} />;
  } else if (!templates || templates.length === 0) {
    body = <GalleryEmpty searching={search.trim().length > 0} canManage={canManage} />;
  } else {
    body = (
      <ul className="flex flex-col gap-2">
        {templates.map((template) => (
          <li key={template.id}>
            <TemplateCard template={template} selected={template.id === selectedId} onSelect={() => onSelect(template.id)} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby="template-gallery-title" className="flex flex-col gap-2">
      <h2 id="template-gallery-title" className="text-[13px] font-semibold text-muted-foreground">
        {format(copy.title, { count: templates?.length ?? 0 })}
      </h2>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          aria-label={copy.search}
          placeholder={copy.search}
          className="pl-8"
        />
      </div>
      {body}
      {canManage ? (
        <button
          type="button"
          onClick={onSaveProject}
          className="flex items-center gap-2 rounded-xl border border-dashed px-3.5 py-3 text-left text-[13px] text-foreground/80 outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Copy aria-hidden className="size-3.5" />
          {copy.saveProject}
        </button>
      ) : null}
    </section>
  );
}
