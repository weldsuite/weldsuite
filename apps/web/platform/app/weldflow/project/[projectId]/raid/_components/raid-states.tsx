import { AlertCircle, Plus, ShieldAlert } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import type { RaidKind } from '@weldsuite/app-api-client/domains/project-control';
import { useI18n } from '@/lib/i18n/provider';
import { useRaid } from './raid-context';

/** Placeholders while the register loads: the tiles and a table. */
export function RaidLoadingState({ tiles = 4 }: Readonly<{ tiles?: number }>) {
  const { t } = useI18n();
  return (
    <div role="status" aria-busy="true" aria-label={t.projects.raid.title} className="flex flex-col gap-4">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr))]">
        {Array.from({ length: tiles }, (_, index) => (
          <Skeleton key={index} className="h-[5.5rem] rounded-lg" />
        ))}
      </div>
      <div className="overflow-hidden rounded-lg border">
        <Skeleton className="h-10 rounded-none" />
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="mt-px h-14 rounded-none" />
        ))}
      </div>
    </div>
  );
}

/** The register could not be loaded. */
export function RaidErrorState() {
  const { t } = useI18n();
  const { retry } = useRaid();
  const copy = t.projects.raid.states;
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
      <div className="rounded-full bg-muted p-3">
        <AlertCircle aria-hidden className="size-6 text-muted-foreground" />
      </div>
      <h2 className="text-base font-semibold">{copy.loadFailedTitle}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{copy.loadFailedDescription}</p>
      <Button type="button" variant="outline" onClick={retry}>
        {copy.retry}
      </Button>
    </div>
  );
}

/** A register with nothing in it yet. */
export function RaidEmptyState({ kind }: Readonly<{ kind: RaidKind }>) {
  const { t } = useI18n();
  const { abilities, openCreate } = useRaid();
  const copy = t.projects.raid;
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
      <div className="rounded-full bg-muted p-3">
        <ShieldAlert aria-hidden className="size-6 text-muted-foreground" />
      </div>
      <h2 className="text-base font-semibold">{copy.states.emptyTitle[kind]}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        {abilities.create ? copy.states.emptyDescription[kind] : copy.states.emptyReadOnly}
      </p>
      {abilities.create ? (
        <Button type="button" onClick={() => openCreate(kind)}>
          <Plus aria-hidden />
          {copy.newItem[kind]}
        </Button>
      ) : null}
    </div>
  );
}
