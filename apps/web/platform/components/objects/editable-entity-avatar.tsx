import { useRef } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { useFileUpload } from '@/hooks/use-file-upload';
import { cn } from '@/lib/utils';

interface EditableEntityAvatarProps {
  /** Current avatar image src (explicit avatarUrl or a gravatar fallback). */
  src?: string;
  /** Fallback initial shown when there's no image. */
  initial: string;
  /** Called with the uploaded file's public URL once the upload confirms. */
  onUploaded: (url: string) => void;
  /** Storage tagging — e.g. "person-avatar" / "company-avatar". */
  entityType: string;
  entityId?: string;
  className?: string;
}

const ALLOWED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * The entity header avatar, made clickable to upload a new image. Hovering
 * reveals a camera overlay; picking a file uploads it to R2 (public) and
 * reports the resulting URL so the caller can persist it via the entity's
 * update mutation.
 */
export function EditableEntityAvatar({
  src,
  initial,
  onUploaded,
  entityType,
  entityId,
  className,
}: EditableEntityAvatarProps) {
  const t = useTranslations();
  const inputRef = useRef<HTMLInputElement>(null);

  const { uploadFile, isUploading } = useFileUpload({
    folder: 'avatars',
    entityType,
    entityId,
    isPublic: true,
    allowedTypes: ALLOWED,
    maxFileSize: MAX_BYTES,
    onSuccess: (file) => {
      onUploaded(file.url);
      toast.success(t('sweep.entities.avatarUpdated'));
    },
    onError: (err) => toast.error(err),
  });

  const handlePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void uploadFile(file);
    e.target.value = ''; // allow re-picking the same file
  };

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => inputRef.current?.click()}
      disabled={isUploading}
      aria-label={t('sweep.entities.uploadAvatar')}
      className={cn(
        'group relative h-7 w-7 shrink-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <Avatar className="h-7 w-7 rounded-lg border border-border">
        {src && <AvatarImage src={src} className="rounded-lg object-cover" />}
        <AvatarFallback className="rounded-lg bg-muted text-[12px] font-medium">
          {initial}
        </AvatarFallback>
      </Avatar>
      <span
        className={cn(
          'absolute inset-0 flex items-center justify-center rounded-lg bg-black/45 transition-opacity',
          isUploading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        {isUploading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-white" />
        ) : (
          <Camera className="h-3.5 w-3.5 text-white" />
        )}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handlePick}
      />
    </Button>
  );
}
