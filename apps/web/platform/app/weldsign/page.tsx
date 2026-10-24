import { FileUp, PenLine, Plus, Send, Signature } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';

/**
 * WeldSign home. Phase 0 of docs/plans/weldsign.md: the module is registered
 * but sign-api has no envelope routes yet, so this is the empty state only.
 * The list of signature requests replaces it in phase 1.
 */
export default function WeldSignHome() {
  const { t } = useI18n();
  const th = t.weldsign.home;
  const canCreate = useCan('sign_envelopes:create');

  const steps = [
    { icon: FileUp, ...th.steps.upload },
    { icon: PenLine, ...th.steps.fields },
    { icon: Send, ...th.steps.send },
  ];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{th.title}</h1>
          <p className="text-sm text-muted-foreground">{th.description}</p>
        </div>
        {canCreate && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{th.comingSoon}</span>
            <Button size="sm" disabled>
              <Plus />
              {th.newRequest}
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-16 text-center">
        <Signature className="size-8 text-muted-foreground" />
        <p className="font-medium">{th.emptyTitle}</p>
        <p className="max-w-md text-sm text-muted-foreground">{th.emptyDescription}</p>
      </div>

      <ol className="grid gap-4 sm:grid-cols-3">
        {steps.map(({ icon: Icon, title, description }) => (
          <li key={title} className="flex gap-3 rounded-lg border bg-card p-4">
            <Icon className="mt-0.5 size-5 shrink-0 text-primary" />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">{title}</p>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
