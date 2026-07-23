import { useState } from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ImportTasksDialog } from './import-tasks-dialog';
import { useI18n } from '@/lib/i18n/provider';

interface ImportSectionProps {
  projectId: string;
  canWrite: boolean;
}

export function ImportSection({ projectId, canWrite }: ImportSectionProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <div className="max-w-3xl space-y-5 rounded-lg border border-border bg-card p-5">
      <div className="space-y-1">
        <h3 className="text-[13px] font-medium">{t.projects.settings.importHeading}</h3>
        <p className="text-[13px] text-muted-foreground">
          {t.projects.settings.importDesc2}
        </p>
      </div>

      <Button onClick={() => setOpen(true)} disabled={!canWrite} variant="outline" size="sm">
        <Upload className="h-4 w-4" />
        {t.projects.settings.importTasksBtn}
      </Button>

      {!canWrite && (
        <p className="text-xs text-muted-foreground">
          {t.projects.settings.importWriteAccessNote}
        </p>
      )}

      <ImportTasksDialog open={open} onOpenChange={setOpen} projectId={projectId} />
    </div>
  );
}
