
import { useState } from 'react';
import { Trash2, UserPlus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  useCalendarShares,
  useShareCalendar,
  useRemoveCalendarShare,
} from '@/hooks/queries/use-calendar-queries';
import { getTranslations } from '@/lib/i18n';

interface ShareCalendarDialogProps {
  calendarId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareCalendarDialog({ calendarId, open, onOpenChange }: ShareCalendarDialogProps) {
  const { data: sharesData, isLoading } = useCalendarShares(calendarId);
  const shareCalendar = useShareCalendar();
  const removeShare = useRemoveCalendarShare();
  const t = getTranslations('weldcalendar');

  const [memberId, setMemberId] = useState('');
  const [permission, setPermission] = useState<'view' | 'edit' | 'manage'>('view');

  const shares = sharesData?.data || [];

  const PERMISSION_LABELS: Record<string, string> = {
    view: t.shareCalendar.permissionCanView,
    edit: t.shareCalendar.permissionCanEdit,
    manage: t.shareCalendar.permissionCanManage,
  };

  const handleShare = async () => {
    if (!memberId.trim()) return;
    await shareCalendar.mutateAsync({ calendarId, sharedWithId: memberId.trim(), permission });
    setMemberId('');
  };

  const handleRemove = async (shareId: string) => {
    await removeShare.mutateAsync({ calendarId, shareId });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t.shareCalendar.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Add member */}
          <div className="space-y-2">
            <Label>{t.shareCalendar.addMemberLabel}</Label>
            <div className="flex gap-2">
              <Input
                placeholder={t.shareCalendar.memberPlaceholder}
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
                className="flex-1"
              />
              <Select value={permission} onValueChange={(v) => setPermission(v as any)}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="view">{t.shareCalendar.permissionCanView}</SelectItem>
                  <SelectItem value="edit">{t.shareCalendar.permissionCanEdit}</SelectItem>
                  <SelectItem value="manage">{t.shareCalendar.permissionCanManage}</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={handleShare} disabled={shareCalendar.isPending || !memberId.trim()} size="icon">
                <UserPlus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Current shares */}
          <div className="space-y-2">
            <Label>{t.shareCalendar.sharedWithLabel}</Label>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">{t.shareCalendar.loading}</p>
            ) : shares.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.shareCalendar.notShared}</p>
            ) : (
              <div className="space-y-2">
                {shares.map((share) => (
                  <div key={share.id} className="flex items-center justify-between gap-2 p-2 border rounded-md">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{share.sharedWithId}</p>
                      <p className="text-xs text-muted-foreground">{PERMISSION_LABELS[share.permission]}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => handleRemove(share.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
