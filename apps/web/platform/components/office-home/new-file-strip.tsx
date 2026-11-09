import { useRef } from 'react';
import { Plus, Upload } from 'lucide-react';

/**
 * The strip above WeldDocs' and WeldSheets' lists, like WeldBoard's: start a
 * blank file, or import one.
 */
export function NewFileStrip({
  title,
  blankLabel,
  importLabel,
  importHint,
  accept,
  onBlank,
  onImport,
}: Readonly<{
  title: string;
  blankLabel: string;
  importLabel: string;
  /** The file types it takes (".docx, .md, .txt or .html"). */
  importHint: string;
  accept: string;
  onBlank: () => void;
  onImport: (file: File | undefined) => void;
}>) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <section className="border-b bg-muted/40">
      <div className="flex w-full flex-col gap-3 px-4 py-6">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        <div className="flex gap-4 overflow-x-auto pb-1">
          <button type="button" onClick={onBlank} className="group flex w-44 shrink-0 flex-col items-stretch gap-1.5 text-left">
            <span className="flex aspect-[4/3] items-center justify-center rounded-lg border bg-background transition group-hover:border-primary">
              <Plus className="size-8 text-primary" />
            </span>
            <span className="text-sm font-medium">{blankLabel}</span>
          </button>
          <button type="button" onClick={() => fileInput.current?.click()} className="group flex w-44 shrink-0 flex-col items-stretch gap-1.5 text-left">
            <span className="flex aspect-[4/3] flex-col items-center justify-center gap-1 rounded-lg border border-dashed bg-background transition group-hover:border-primary">
              <Upload className="size-8 text-muted-foreground group-hover:text-primary" />
              <span className="text-xs text-muted-foreground">{importHint}</span>
            </span>
            <span className="text-sm font-medium">{importLabel}</span>
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            onImport(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
    </section>
  );
}
