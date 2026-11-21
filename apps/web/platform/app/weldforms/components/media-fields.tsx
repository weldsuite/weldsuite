/**
 * Image and video pickers for questions, choices and themes: upload a file to
 * the public bucket (`/api/forms/media`) or paste a URL.
 */

import { useRef, useState } from 'react';
import { ImagePlus, Link2, Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { FormMedia } from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { FormField } from '@weldsuite/ui/components/form-field';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useI18n } from '@/lib/i18n/provider';
import { useUploadFormMedia } from '@/hooks/queries/use-weldforms-queries';
import { OptionSelect } from './prop-controls';

const VIDEO_URL = /(youtube\.com|youtu\.be|vimeo\.com|\.mp4($|\?)|\.webm($|\?))/i;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** The upload half of a picker: a hidden file input and the mutation behind it. */
function useMediaPicker(onPicked: (url: string, kind: 'image' | 'video') => void) {
  const { t } = useI18n();
  const upload = useUploadFormMedia();
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_MEDIA_BYTES) {
      toast.error(t.weldforms.media.tooLarge);
      return;
    }
    try {
      const result = await upload.mutateAsync(file);
      onPicked(result.url, result.contentType.startsWith('video/') ? 'video' : 'image');
    } catch {
      toast.error(t.weldforms.media.uploadFailed);
    }
  }

  return { upload, inputRef, onFile };
}

interface UrlPopoverProps {
  onSubmit: (url: string) => void;
  disabled?: boolean;
}

function UrlPopover({ onSubmit, disabled }: Readonly<UrlPopoverProps>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const valid = isHttpUrl(value.trim());
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <Link2 className="size-4" />
          {t.weldforms.media.fromUrl}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2" align="start">
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://" aria-label={t.weldforms.media.urlLabel} />
        <Button
          type="button"
          size="sm"
          disabled={!valid}
          onClick={() => {
            onSubmit(value.trim());
            setValue('');
            setOpen(false);
          }}
        >
          {t.weldforms.media.useUrl}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

interface ImageUrlFieldProps {
  label: string;
  value: string | undefined;
  onChange: (url: string | undefined) => void;
  disabled?: boolean;
  /** Upload only, no label and no URL option (a choice's picture). */
  compact?: boolean;
}

/** One image URL: a choice picture, a theme logo or background. */
export function ImageUrlField({ label, value, onChange, disabled, compact }: Readonly<ImageUrlFieldProps>) {
  const { t } = useI18n();
  const picker = useMediaPicker((url) => onChange(url));
  const busy = picker.upload.isPending;

  const body = (
    <div className="flex flex-wrap items-center gap-2">
      {value && <img src={value} alt="" className="size-10 rounded border object-cover" />}
      <input
        ref={picker.inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          void picker.onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <Button type="button" variant="outline" size="sm" disabled={disabled || busy} onClick={() => picker.inputRef.current?.click()}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        {busy ? t.weldforms.media.uploading : t.weldforms.media.upload}
      </Button>
      {!compact && <UrlPopover disabled={disabled} onSubmit={(url) => onChange(url)} />}
      {value && (
        <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} onClick={() => onChange(undefined)} aria-label={t.weldforms.media.remove}>
          <Trash2 className="size-4" />
        </Button>
      )}
    </div>
  );
  return compact ? body : <FormField label={label}>{body}</FormField>;
}

interface MediaFieldProps {
  value: FormMedia | undefined;
  onChange: (media: FormMedia | undefined) => void;
  disabled?: boolean;
  /** Placement options apply to the conversational layout only. */
  showPlacement?: boolean;
}

/** The image or video on a question or screen, with alt text and placement. */
export function MediaField({ value, onChange, disabled, showPlacement = true }: Readonly<MediaFieldProps>) {
  const { t } = useI18n();
  const tm = t.weldforms.media;
  const picker = useMediaPicker((url, kind) => onChange({ kind, url, placement: value?.placement ?? 'above', alt: value?.alt }));
  const busy = picker.upload.isPending;

  const placements = (['above', 'split_left', 'split_right', 'background'] as const).map((p) => ({ value: p, label: tm.placement[p] }));

  return (
    <div className="space-y-2">
      <span className="text-sm font-medium">{tm.label}</span>
      {value ? (
        <div className="space-y-2 rounded-md border p-2">
          <div className="flex items-center gap-2">
            {value.kind === 'image' ? (
              <img src={value.url} alt="" className="size-12 rounded border object-cover" />
            ) : (
              <span className="grid size-12 place-items-center rounded border text-xs text-muted-foreground">{tm.video}</span>
            )}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{value.url}</span>
            <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} onClick={() => onChange(undefined)} aria-label={tm.remove}>
              <Trash2 className="size-4" />
            </Button>
          </div>
          <Input
            value={value.alt ?? ''}
            onChange={(e) => onChange({ ...value, alt: e.target.value === '' ? undefined : e.target.value })}
            placeholder={tm.altPlaceholder}
            aria-label={tm.altLabel}
            maxLength={500}
            disabled={disabled}
          />
          {showPlacement && (
            <OptionSelect label={tm.placementLabel} value={value.placement} options={placements} disabled={disabled} onChange={(placement) => onChange({ ...value, placement })} />
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <input
            ref={picker.inputRef}
            type="file"
            accept="image/*,video/mp4,video/webm"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              void picker.onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <Button type="button" variant="outline" size="sm" disabled={disabled || busy} onClick={() => picker.inputRef.current?.click()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
            {busy ? tm.uploading : tm.add}
          </Button>
          <UrlPopover disabled={disabled} onSubmit={(url) => onChange({ kind: VIDEO_URL.test(url) ? 'video' : 'image', url, placement: 'above' })} />
        </div>
      )}
    </div>
  );
}
