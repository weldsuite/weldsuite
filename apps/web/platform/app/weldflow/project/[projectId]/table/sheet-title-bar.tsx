import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { tablesApi } from '@/app/weldflow/lib/api-client';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';

interface SheetTitleBarProps {
  projectId: string;
  tableId: string;
  /** Current saved name of the sheet; empty until the list has loaded. */
  name?: string;
  onBack: () => void;
}

/**
 * Header of the sheet editor: a link back to the sheets list and the sheet's
 * name, editable in place by anyone with write access to the project.
 */
export function SheetTitleBar({ projectId, tableId, name = '', onBack }: Readonly<SheetTitleBarProps>) {
  const { t } = useI18n();
  const { canWrite } = useProjectPermissions();
  const [value, setValue] = useState(name);
  const savedRef = useRef(name);

  // Follow the saved name when it arrives (or changes) from the parent.
  useEffect(() => {
    setValue(name);
    savedRef.current = name;
  }, [name]);

  const commit = async () => {
    const next = value.trim();
    if (!next) {
      setValue(savedRef.current);
      return;
    }
    if (next === savedRef.current) return;
    const result = await tablesApi.updateTable(projectId, tableId, { name: next });
    if (result.success) {
      savedRef.current = next;
      setValue(next);
      toast.success(t.projects.table.tableRenamed);
    } else {
      setValue(savedRef.current);
      toast.error(t.projects.table.failedToRenameTable);
    }
  };

  return (
    <div className="flex items-center gap-2 border-b px-3 py-1.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-muted-foreground"
        onClick={onBack}
        title={t.projects.table.backToSheets}
      >
        <ArrowLeft className="h-4 w-4" />
        {t.projects.table.backToSheets}
      </Button>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setValue(savedRef.current);
            e.currentTarget.blur();
          }
        }}
        readOnly={!canWrite}
        aria-label={t.projects.table.sheetNameLabel}
        placeholder={t.projects.table.untitled}
        className="h-7 min-w-0 max-w-md flex-1 rounded-md border border-transparent bg-transparent px-2 text-sm font-medium outline-none hover:border-border focus:border-border"
      />
    </div>
  );
}
