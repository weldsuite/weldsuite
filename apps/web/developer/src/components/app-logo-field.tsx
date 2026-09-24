import { useRef, useState, type ChangeEvent } from 'react';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useAppApiClient } from '@/lib/api';
import { useDeveloperI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const ACCEPTED = 'image/png,image/jpeg,image/webp,image/svg+xml';
const MAX_BYTES = 2 * 1024 * 1024;

function isLogoUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return (
    /^https?:\/\//i.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('data:image/')
  );
}

interface GenerateUploadUrlResponse {
  success: boolean;
  uploadUrl: string;
  uploadToken: string;
  fileKey: string;
}

interface ConfirmUploadResponse {
  success: boolean;
  file: { url: string };
}

export function AppLogoField({
  appId,
  value,
  onChange,
  disabled,
}: Readonly<{
  appId: string;
  value: string;
  onChange: (next: string) => void | Promise<void>;
  disabled?: boolean;
}>) {
  const { t } = useDeveloperI18n();
  const { getClient } = useAppApiClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasLogo = isLogoUrl(value);

  const onPick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError(null);
    if (!ACCEPTED.split(',').includes(file.type)) {
      setError(t.create.logoTypeError);
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(t.create.logoSizeError);
      return;
    }

    setUploading(true);
    try {
      const client = await getClient();
      const urlRes = await client.post<GenerateUploadUrlResponse>('/storage/generate-upload-url', {
        fileName: file.name,
        fileSize: file.size,
        contentType: file.type,
        entityType: 'user-app-logo',
        entityId: appId,
        isPublic: true,
      });

      const put = await fetch(urlRes.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!put.ok) {
        throw new Error(t.create.logoUploadError);
      }

      const confirmed = await client.post<ConfirmUploadResponse>('/storage/confirm-upload', {
        uploadToken: urlRes.uploadToken,
        fileKey: urlRes.fileKey,
      });

      const nextUrl = confirmed.file?.url;
      if (!nextUrl) {
        throw new Error(t.create.logoUploadError);
      }
      await onChange(nextUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.create.logoUploadError);
    } finally {
      setUploading(false);
    }
  };

  const onRemove = async () => {
    setError(null);
    try {
      await onChange('Puzzle');
    } catch (err) {
      setError(err instanceof Error ? err.message : t.create.logoUploadError);
    }
  };

  return (
    <div className="space-y-2">
      <span className="text-sm font-medium">{t.create.logoLabel}</span>
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted',
          )}
        >
          {hasLogo ? (
            <img src={value} alt="" className="h-full w-full object-contain" />
          ) : (
            <ImagePlus className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED}
            className="sr-only"
            onChange={onPick}
            disabled={disabled || uploading}
          />
          <button
            type="button"
            disabled={disabled || uploading}
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-60"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
            {hasLogo ? t.create.logoReplace : t.create.logoUpload}
          </button>
          {hasLogo ? (
            <button
              type="button"
              disabled={disabled || uploading}
              onClick={() => void onRemove()}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-2 text-sm text-muted-foreground hover:text-destructive disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" />
              {t.create.logoRemove}
            </button>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t.create.logoHint}</p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
