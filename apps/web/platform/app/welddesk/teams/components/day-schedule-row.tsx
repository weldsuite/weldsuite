import { Switch } from '@weldsuite/ui/components/switch';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useI18n } from '@/lib/i18n/provider';

interface DayScheduleRowProps {
  day: string;
  label: string;
  isOpen: boolean;
  openTime?: string;
  closeTime?: string;
  onToggle: (isOpen: boolean) => void;
  onOpenTimeChange: (time: string) => void;
  onCloseTimeChange: (time: string) => void;
}

export function DayScheduleRow({
  day,
  label,
  isOpen,
  openTime = '09:00',
  closeTime = '17:00',
  onToggle,
  onOpenTimeChange,
  onCloseTimeChange,
}: DayScheduleRowProps) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="w-24 flex-shrink-0">
        <Label className="text-sm font-medium">{label}</Label>
      </div>
      <Switch
        checked={isOpen}
        onCheckedChange={onToggle}
      />
      {isOpen ? (
        <div className="flex items-center gap-2 flex-1">
          <Input
            type="time"
            value={openTime}
            onChange={(e) => onOpenTimeChange(e.target.value)}
            className="w-[130px] shadow-none"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            type="time"
            value={closeTime}
            onChange={(e) => onCloseTimeChange(e.target.value)}
            className="w-[130px] shadow-none"
          />
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">{t.helpdesk.teamsPage.closed}</span>
      )}
    </div>
  );
}
