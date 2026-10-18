import { Building2, Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';
import { useI18n } from '@/lib/i18n/provider';
import { copyText } from '@/lib/clipboard';
import { DriveAccessList } from './drive-access-list';
import { driveItemLink } from './drive-utils';

interface ShareFileDialogProps {
  file: UnifiedFile | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Share a Drive file: who can open it and the in-app link to send them.
 * Access follows the workspace (anyone with WeldDrive access), so sharing is
 * handing a teammate the link.
 */
export function ShareFileDialog({ file, onOpenChange }: Readonly<ShareFileDialogProps>) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const link = file ? driveItemLink(file) : null;

  const handleCopy = () => {
    if (!link) return;
    copyText(link, () => {
      setCopied(true);
      toast.success(t.welddrive.toasts.linkCopied);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Dialog open={!!file} onOpenChange={(open) => { if (!open) setCopied(false); onOpenChange(open); }}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">
            {t.welddrive.share.title.replace('{name}', file?.name ?? '')}
          </DialogTitle>
          <DialogDescription>{t.welddrive.share.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
            <Building2 className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t.welddrive.share.generalAccessTitle}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{t.welddrive.share.generalAccessDescription}</p>
            </div>
          </div>

          {file && (
            <div>
              <p className="text-sm font-medium text-foreground mb-3">{t.welddrive.fileDetail.whoHasAccess}</p>
              <DriveAccessList file={file} />
            </div>
          )}

          {link && (
            <div>
              <p className="text-sm font-medium text-foreground mb-1.5">{t.welddrive.share.linkLabel}</p>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={link}
                  className="h-9 font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label={t.welddrive.share.linkLabel}
                />
                <Button variant="outline" className="h-9 shrink-0" onClick={handleCopy}>
                  {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                  {t.welddrive.share.copyLink}
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t.welddrive.share.done}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
