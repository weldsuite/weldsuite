import { useEffect, useRef, useState, type DragEvent, type PointerEvent } from 'react';
import { File as FileIcon, Upload, X } from 'lucide-react';
import type { FieldBlockOf, FileAnswerItem } from '@weldsuite/forms-engine';
import { useFieldEnv, type FieldViewProps } from '../env';
import { acceptAttribute, fileMatchesAccept, fill } from '../utils';
import type { UploadHandler } from '../types';

let localCounter = 0;

/** What an upload handler does in preview, where there is no server: the file stays in the browser. */
const previewUpload: UploadHandler = (_fieldId, file) => {
  localCounter += 1;
  return Promise.resolve({ fileId: `preview_${localCounter}`, name: file.name, size: file.size, type: file.type || 'application/octet-stream' });
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Pending {
  key: number;
  name: string;
  progress: number;
  failed: boolean;
}

export function FileUploadField({ field, value, onChange, error, inputId, describedBy }: FieldViewProps<FieldBlockOf<'file_upload'>>) {
  const { labels, onUpload, preview, trackUpload } = useFieldEnv();
  const { maxFiles, maxSizeMb, accept } = field.properties;
  const items: FileAnswerItem[] = Array.isArray(value) ? (value as FileAnswerItem[]) : [];
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [pending, setPending] = useState<Pending[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const pendingCount = useRef(0);
  const upload = onUpload ?? (preview ? previewUpload : undefined);

  function addFiles(files: File[]) {
    setProblem(null);
    if (!upload) return;
    for (const file of files) {
      if (itemsRef.current.length + pendingCount.current >= maxFiles) {
        setProblem(fill(labels.errors.too_many_files, { max: maxFiles }));
        break;
      }
      if (file.size > maxSizeMb * 1024 * 1024) {
        setProblem(fill(labels.fileTooLarge, { max: maxSizeMb }));
        continue;
      }
      if (!fileMatchesAccept(file, accept)) {
        setProblem(labels.fileTypeNotAllowed);
        continue;
      }
      start(file, upload);
    }
  }

  function start(file: File, handler: UploadHandler) {
    const key = (counter.current += 1);
    pendingCount.current += 1;
    setPending((p) => [...p, { key, name: file.name, progress: 0, failed: false }]);
    const done = handler(field.id, file, (fraction) =>
      setPending((p) => p.map((x) => (x.key === key ? { ...x, progress: Math.min(1, Math.max(0, fraction)) } : x))),
    ).then(
      (item) => {
        pendingCount.current -= 1;
        setPending((p) => p.filter((x) => x.key !== key));
        itemsRef.current = [...itemsRef.current, item];
        onChange(itemsRef.current);
      },
      () => {
        pendingCount.current -= 1;
        setPending((p) => p.map((x) => (x.key === key ? { ...x, failed: true } : x)));
      },
    );
    trackUpload(done);
  }

  function remove(fileId: string) {
    const next = itemsRef.current.filter((i) => i.fileId !== fileId);
    itemsRef.current = next;
    onChange(next.length === 0 ? undefined : next);
    setProblem(null);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setOver(false);
    addFiles(Array.from(e.dataTransfer.files));
  }

  const full = items.length + pending.filter((p) => !p.failed).length >= maxFiles;
  return (
    <div>
      <div
        className="wf-dropzone"
        data-over={over || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <Upload size={28} aria-hidden="true" />
        <p>{labels.dropFiles}</p>
        <button
          type="button"
          id={inputId}
          className="wf-button wf-button-secondary"
          data-wf-focus=""
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          disabled={full}
          onClick={() => input.current?.click()}
        >
          {labels.browse}
        </button>
        <input
          ref={input}
          type="file"
          className="wf-sr-only"
          tabIndex={-1}
          aria-hidden="true"
          multiple={maxFiles > 1}
          accept={acceptAttribute(accept)}
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <p className="wf-hint">
          {maxFiles > 1 ? `${maxFiles} x ` : ''}
          {maxSizeMb} MB
        </p>
      </div>
      {problem ? (
        <p className="wf-error-text" role="alert">
          {problem}
        </p>
      ) : null}
      <ul className="wf-files" aria-live="polite">
        {items.map((item) => (
          <li key={item.fileId} className="wf-file">
            <FileIcon size={16} aria-hidden="true" />
            <span className="wf-file-name">{item.name}</span>
            <span className="wf-hint">{formatSize(item.size)}</span>
            <button type="button" className="wf-icon-button" aria-label={fill(labels.removeFile, { name: item.name })} onClick={() => remove(item.fileId)}>
              <X size={16} aria-hidden="true" />
            </button>
          </li>
        ))}
        {pending.map((p) => (
          <li key={p.key} className="wf-file" data-failed={p.failed || undefined}>
            <FileIcon size={16} aria-hidden="true" />
            <span className="wf-file-name">{p.name}</span>
            {p.failed ? (
              <>
                <span className="wf-error-text">{labels.uploadFailed}</span>
                <button
                  type="button"
                  className="wf-icon-button"
                  aria-label={fill(labels.removeFile, { name: p.name })}
                  onClick={() => setPending((list) => list.filter((x) => x.key !== p.key))}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </>
            ) : (
              <progress className="wf-file-progress" max={1} value={p.progress} aria-label={`${labels.uploading} ${p.name}`} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

type Status = 'idle' | 'saving' | 'saved' | 'failed';

export function SignatureField({ field, value, onChange, error, inputId, describedBy }: FieldViewProps<FieldBlockOf<'signature'>>) {
  const { labels, onUpload, preview, trackUpload } = useFieldEnv();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<Status>(value ? 'saved' : 'idle');
  const upload = onUpload ?? (preview ? previewUpload : undefined);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // The canvas keeps a device-pixel backing store so the line stays sharp.
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext?.('2d');
    if (!el || !ctx) return;
    const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const width = el.clientWidth || 480;
    const height = el.clientHeight || 180;
    el.width = width * ratio;
    el.height = height * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
  }, []);

  function point(e: PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function save() {
    const el = canvas.current;
    if (!el || !upload || !dirty.current) return;
    setStatus('saving');
    el.toBlob((blob) => {
      if (!blob) {
        setStatus('failed');
        return;
      }
      const file = new File([blob], 'signature.png', { type: 'image/png' });
      const done = upload(field.id, file).then(
        (item) => {
          dirty.current = false;
          setStatus('saved');
          onChange(item);
        },
        () => setStatus('failed'),
      );
      trackUpload(done);
    }, 'image/png');
  }

  function scheduleSave() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(save, 500);
  }

  function clear() {
    const el = canvas.current;
    const ctx = el?.getContext?.('2d');
    if (el && ctx) ctx.clearRect(0, 0, el.width, el.height);
    if (timer.current) clearTimeout(timer.current);
    dirty.current = false;
    setStatus('idle');
    onChange(undefined);
  }

  const statusText: Record<Status, string> = {
    idle: labels.signatureHint,
    saving: labels.signatureSaving,
    saved: labels.signatureSaved,
    failed: labels.uploadFailed,
  };
  return (
    <div>
      <canvas
        ref={canvas}
        id={inputId}
        className="wf-signature"
        role="img"
        aria-label={labels.signatureHint}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        data-wf-focus=""
        onPointerDown={(e) => {
          const ctx = e.currentTarget.getContext?.('2d');
          if (!ctx) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drawing.current = true;
          const p = point(e);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          // A tap leaves a dot.
          ctx.lineTo(p.x + 0.01, p.y + 0.01);
          ctx.stroke();
          if (timer.current) clearTimeout(timer.current);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext?.('2d');
          if (!ctx) return;
          const p = point(e);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          dirty.current = true;
        }}
        onPointerUp={() => {
          if (!drawing.current) return;
          drawing.current = false;
          dirty.current = true;
          scheduleSave();
        }}
        onPointerCancel={() => {
          drawing.current = false;
        }}
      />
      <div className="wf-signature-bar">
        <span className="wf-hint" aria-live="polite">
          {statusText[status]}
        </span>
        <button type="button" className="wf-link-button" onClick={clear}>
          {labels.signatureClear}
        </button>
      </div>
    </div>
  );
}

