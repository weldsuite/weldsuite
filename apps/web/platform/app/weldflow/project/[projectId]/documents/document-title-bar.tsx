import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { documentsApi } from '@/app/weldflow/lib/api-client';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import type { HtmlDocSaveStatus } from '@/lib/documents/use-html-doc';

interface DocumentTitleBarProps {
  projectId: string;
  fileId: string;
  /** Current saved name of the document; empty until the list has loaded. */
  name?: string;
  status: HtmlDocSaveStatus;
  onBack: () => void;
}

/**
 * Header of the document editor: back link to the documents list, the
 * document's name (editable in place with write access) and a save indicator.
 */
export function DocumentTitleBar({ projectId, fileId, name = '', status, onBack }: Readonly<DocumentTitleBarProps>) {
  const { t } = useI18n();
  const { canWrite } = useProjectPermissions();
  const [value, setValue] = useState(name);
  const savedRef = useRef(name);

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
    const result = await documentsApi.updateDocument(projectId, fileId, { name: next });
    if (result.success) {
      savedRef.current = next;
      setValue(next);
      toast.success(t.projects.documents.documentRenamed);
    } else {
      setValue(savedRef.current);
      toast.error(t.projects.documents.failedToRenameDocument);
    }
  };

  const statusLabel =
    status === 'saving' || status === 'dirty'
      ? t.projects.documents.savingDocument
      : status === 'saved'
        ? t.projects.documents.savedDocument
        : status === 'error'
          ? t.projects.documents.errorSavingDocument
          : '';

  return (
    <div className="flex items-center gap-2 border-b px-3 py-1.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-muted-foreground"
        onClick={onBack}
        title={t.projects.documents.backToDocuments}
      >
        <ArrowLeft className="h-4 w-4" />
        {t.projects.documents.backToDocuments}
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
        aria-label={t.projects.documents.documentTitle}
        placeholder={t.projects.documents.untitledDocument}
        className="h-7 min-w-0 max-w-md flex-1 rounded-md border border-transparent bg-transparent px-2 text-sm font-medium outline-none hover:border-border focus:border-border"
      />
      <span
        role="status"
        aria-live="polite"
        className={
          status === 'error'
            ? 'ml-auto text-xs text-destructive'
            : 'ml-auto text-xs text-muted-foreground'
        }
      >
        {statusLabel}
      </span>
    </div>
  );
}
