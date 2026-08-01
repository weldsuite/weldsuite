/**
 * Image editor for the product dialog.
 *
 * Uploads go through the shared `useFileUpload` hook (R2 via `/storage`), with
 * `isPublic: true` — a storefront image has to be fetchable without a session
 * token, unlike the private attachments that hook is normally used for.
 *
 * The first image is the featured one. That's a deliberate simplification over
 * a separate "set featured" toggle: `products.featuredImageUrl` is a single
 * column, and reorder-to-promote is one fewer concept than a star per row.
 */

import { useRef, useState } from 'react';
import { ImagePlus, Loader2, Star, Trash2, ArrowUp } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { toast } from 'sonner';
import { useFileUpload } from '@/hooks/use-file-upload';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export interface ProductImage {
  url: string;
  altText?: string;
  id?: string;
}

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 20;

export function ProductImagesField({
  value,
  onChange,
}: {
  value: ProductImage[];
  onChange: (next: ProductImage[]) => void;
}) {
  const t = getTranslations('commerce').module;
  const inputRef = useRef<HTMLInputElement>(null);
  const [altDraft, setAltDraft] = useState<Record<number, string>>({});

  const { uploadMultiple, isUploading, progress } = useFileUpload({
    folder: 'product-images',
    entityType: 'product',
    isPublic: true,
    maxFileSize: MAX_BYTES,
    allowedTypes: ACCEPTED,
    onError: (message) => toast.error(message),
  });

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const room = MAX_IMAGES - value.length;
    if (room <= 0) {
      toast.error(t.images.maxReached);
      return;
    }
    const picked = Array.from(files).slice(0, room);
    const uploaded = await uploadMultiple(picked);
    if (uploaded.length === 0) return;
    onChange([...value, ...uploaded.map((f) => ({ url: f.url, id: f.id }))]);
    // Let the same file be picked again after a remove.
    if (inputRef.current) inputRef.current.value = '';
  };

  const removeAt = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const promoteToFeatured = (index: number) => {
    if (index === 0) return;
    const next = [...value];
    const [moved] = next.splice(index, 1);
    next.unshift(moved);
    onChange(next);
  };

  const setAlt = (index: number, altText: string) => {
    onChange(value.map((img, i) => (i === index ? { ...img, altText: altText || undefined } : img)));
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label>{t.images.label}</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isUploading || value.length >= MAX_IMAGES}
          onClick={() => inputRef.current?.click()}
        >
          {isUploading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {progress > 0 ? `${progress}%` : t.images.uploading}
            </>
          ) : (
            <>
              <ImagePlus className="mr-2 h-4 w-4" />
              {t.images.add}
            </>
          )}
        </Button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(',')}
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.images.empty}</p>
      ) : (
        <ul className="grid gap-2">
          {value.map((img, index) => (
            <li
              key={img.id ?? `${img.url}-${index}`}
              className={cn(
                'flex items-center gap-3 rounded-md border p-2',
                index === 0 && 'border-primary/50 bg-accent/30',
              )}
            >
              <img
                src={img.url}
                alt={img.altText ?? ''}
                className="h-12 w-12 shrink-0 rounded object-cover bg-muted"
              />
              <div className="min-w-0 flex-1">
                {index === 0 && (
                  <span className="mb-1 flex items-center gap-1 text-xs font-medium text-primary">
                    <Star className="h-3 w-3" />
                    {t.images.featured}
                  </span>
                )}
                <Input
                  value={altDraft[index] ?? img.altText ?? ''}
                  placeholder={t.images.altPlaceholder}
                  onChange={(e) => setAltDraft((d) => ({ ...d, [index]: e.target.value }))}
                  onBlur={(e) => setAlt(index, e.target.value)}
                  className="h-8"
                />
              </div>
              {index !== 0 && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  title={t.images.makeFeatured}
                  onClick={() => promoteToFeatured(index)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
              )}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title={t.images.remove}
                onClick={() => removeAt(index)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
