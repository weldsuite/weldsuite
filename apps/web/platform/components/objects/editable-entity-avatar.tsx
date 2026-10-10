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
}: Readonly<EditableEntityAvatarProps>) {
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
      // 22×22 with 8px corners and no border — the same header avatar as the
      // team member panel. `p-0`: the ghost button's own padding otherwise
      // forces it wider than the avatar it wraps. `flex` (not the button's
      // default inline-flex): an inline box sits in a text line and drops the
      // avatar below the header's centre line.
      className={cn(
        'group relative flex size-[22px] shrink-0 rounded-[8px] p-0 outline-none hover:bg-transparent dark:hover:bg-transparent focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <Avatar className="size-[22px] !rounded-[8px]">
        {src && <AvatarImage src={src} className="!rounded-[8px] object-cover" />}
        <AvatarFallback className="!rounded-[8px] bg-muted text-[10px] font-medium">
          {initial}
        </AvatarFallback>
      </Avatar>
      <span
        className={cn(
          'absolute inset-0 flex items-center justify-center rounded-[8px] bg-black/45 transition-opacity',
          isUploading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        {isUploading ? (
          <Loader2 className="size-3 animate-spin text-white" />
        ) : (
          <Camera className="size-3 text-white" />
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
