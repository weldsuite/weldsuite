import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useFileUpload } from '@/hooks/use-file-upload';
import { useI18n } from '@/lib/i18n/provider';
import { fileToDataUrl, insertImage } from './model/image-actions';
import type { DocController } from './model/doc-controller';

/** Largest image a document takes (bigger ones belong in WeldDrive as files). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];

/**
 * Insert an image: upload one (to WeldDrive storage in a workspace; inside
 * the document in the signed-out preview) or point at a web address.
 */
export function ImageDialog({ controller, onClose }: { controller: DocController; onClose: () => void }) {
  const { t } = useI18n();
  const ti = t.welddocs.image;
  const preview = usePreviewMode();
  const { uploadFile, isUploading } = useFileUpload({ folder: 'welddocs', maxFileSize: MAX_IMAGE_BYTES, allowedTypes: IMAGE_TYPES });
  const fileInput = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const insert = async (src: string) => {
    setBusy(true);
    const ok = await insertImage(controller, src);
    setBusy(false);
    if (!ok) {
      toast.error(ti.failed);
      return;
    }
    onClose();
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type) || file.size > MAX_IMAGE_BYTES) {
      toast.error(ti.unsupported);
      return;
    }
    if (preview) {
      await insert(await fileToDataUrl(file));
      return;
    }
    const result = await uploadFile(file);
    if (!result) {
      toast.error(ti.failed);
      return;
    }
    await insert(result.url);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{ti.title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 text-sm">
          <Button variant="outline" disabled={busy || isUploading} onClick={() => fileInput.current?.click()}>
            {isUploading ? ti.uploading : ti.upload}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept={IMAGE_TYPES.join(',')}
            className="hidden"
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <form
            className="flex flex-col gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (/^https:\/\//i.test(url.trim())) void insert(url.trim());
              else toast.error(ti.invalidUrl);
            }}
          >
            <span className="text-xs font-medium text-muted-foreground">{ti.byUrl}</span>
            <div className="flex gap-2">
              <input value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} className="h-8 min-w-0 flex-1 rounded border bg-background px-2" />
              <Button type="submit" size="sm" disabled={busy || !url.trim()}>
                {ti.insert}
              </Button>
            </div>
          </form>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {ti.cancel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
