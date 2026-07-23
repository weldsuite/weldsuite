import { Pin } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';

interface ReplacePinDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pinnedMessages: any[];
  onReplace: (messageIdToUnpin: string) => void;
}

export function ReplacePinDialog({
  open,
  onOpenChange,
  pinnedMessages,
  onReplace,
}: ReplacePinDialogProps) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t.weldchat.replacePin.title}</DialogTitle>
          <DialogDescription>
            {t.weldchat.replacePin.description}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {pinnedMessages.map((msg: any) => (
            <Button
              key={msg.id}
              variant="ghost"
              onClick={() => onReplace(msg.id)}
              className="w-full flex items-start gap-3 p-3 rounded-lg border hover:bg-accent transition-colors text-left"
            >
              <Pin className="h-4 w-4 text-primary flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{msg.authorName}</p>
                <p className="text-sm text-muted-foreground truncate">{msg.content}</p>
              </div>
            </Button>
          ))}
        </div>
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.weldchat.replacePin.cancel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
