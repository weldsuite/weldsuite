
import { useState, useEffect } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  Building2,
  Calendar as CalendarIcon,
  DollarSign,
  Loader2,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslations } from '@weldsuite/i18n/client';

interface Deal {
  id: string;
  title: string;
  value: number;
  currency?: string;
  stage: string;
  company?: {
    id: string;
    name: string;
    logoUrl?: string;
  };
  contact?: {
    id: string;
    name: string;
    email?: string;
    avatarUrl?: string;
  };
  owner?: {
    id: string;
    name: string;
    email?: string;
    avatarUrl?: string;
  };
  probability?: number;
  expectedCloseDate?: Date | string;
  lastActivity?: Date | string;
  tags?: string[];
  notes?: string;
}

interface EditDealModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal: Deal | null;
  onSubmit: (dealId: string, data: any) => Promise<void>;
  onDelete?: (dealId: string) => Promise<void>;
}

export function EditDealModal({
  open,
  onOpenChange,
  deal,
  onSubmit,
  onDelete,
}: EditDealModalProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const [loading, setLoading] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Form fields
  const [dealTitle, setDealTitle] = useState('');
  const [dealValue, setDealValue] = useState('');
  const [probability, setProbability] = useState('');
  const [expectedCloseDate, setExpectedCloseDate] = useState<Date | undefined>();
  const [dateValue, setDateValue] = useState('');
  const [notes, setNotes] = useState('');

  // Reset form when deal changes
  useEffect(() => {
    if (deal) {
      setDealTitle(deal.title || '');
      setDealValue(deal.value?.toString() || '');
      setProbability(deal.probability?.toString() || '');
      setNotes(deal.notes || '');
      if (deal.expectedCloseDate) {
        const date = new Date(deal.expectedCloseDate);
        setExpectedCloseDate(date);
        setDateValue(formatDate(date));
      } else {
        setExpectedCloseDate(undefined);
        setDateValue('');
      }
    }
  }, [deal]);

  const formatDate = (date: Date | undefined) => {
    if (!date) return "";
    return date.toLocaleDateString("en-US", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
  };

  const isValidDate = (date: Date | undefined) => {
    if (!date) return false;
    return !isNaN(date.getTime());
  };

  const handleSubmit = async () => {
    if (!dealTitle || !dealValue || !deal) return;

    setLoading(true);
    try {
      await onSubmit(deal.id, {
        title: dealTitle,
        value: parseFloat(dealValue),
        probability: probability ? parseInt(probability) : undefined,
        expectedCloseDate,
        notes,
      });
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to update deal:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deal || !onDelete) return;

    try {
      await onDelete(deal.id);
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to delete deal:', error);
    }
  };

  const getInitials = (name: string) => {
    if (!name) return '??';
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const getCompanyName = () => {
    if (deal?.company?.name) return deal.company.name;
    return deal?.title || 'Deal';
  };

  if (!deal) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10 rounded-lg">
              <AvatarImage src={deal.company?.logoUrl} />
              <AvatarFallback className="rounded-lg text-xs bg-primary/10 text-primary">
                {getInitials(getCompanyName())}
              </AvatarFallback>
            </Avatar>
            <div>
              <DialogTitle className="text-base">{st('sweep.weldcrm.editDealModal.title')}</DialogTitle>
              <DialogDescription className="text-xs">
                {deal.company?.name || deal.title}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Deal Title */}
          <div className="space-y-2">
            <Label htmlFor="title">
              {t.crm.deals.detailsModal.dealNameLabel}
              <span className="text-destructive ml-1">*</span>
            </Label>
            <Input
              id="title"
              placeholder={t.crm.deals.detailsModal.dealNamePlaceholder}
              value={dealTitle}
              onChange={(e) => setDealTitle(e.target.value)}
              autoFocus
            />
          </div>

          {/* Deal Value */}
          <div className="space-y-2">
            <Label htmlFor="value">{t.crm.deals.detailsModal.valueLabel}</Label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="value"
                type="number"
                placeholder={t.crm.deals.detailsModal.valuePlaceholder}
                className="pl-9"
                value={dealValue}
                onChange={(e) => setDealValue(e.target.value)}
              />
            </div>
          </div>

          {/* Probability and Expected Close Date */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="probability">{t.crm.deals.detailsModal.probabilityLabel}</Label>
              <Select value={probability} onValueChange={setProbability}>
                <SelectTrigger>
                  <SelectValue placeholder={t.crm.deals.detailsModal.selectProbabilityPlaceholder}>
                    {probability && `${probability}%`}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10%</SelectItem>
                  <SelectItem value="25">25%</SelectItem>
                  <SelectItem value="50">50%</SelectItem>
                  <SelectItem value="75">75%</SelectItem>
                  <SelectItem value="90">90%</SelectItem>
                  <SelectItem value="100">100%</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="close-date">{t.crm.deals.detailsModal.closeDateLabel}</Label>
              <div className="relative">
                <Input
                  id="close-date"
                  value={dateValue}
                  placeholder={t.crm.deals.detailsModal.closeDatePlaceholder}
                  className="bg-background pr-10 cursor-pointer"
                  onChange={(e) => {
                    const date = new Date(e.target.value);
                    setDateValue(e.target.value);
                    if (isValidDate(date)) {
                      setExpectedCloseDate(date);
                    }
                  }}
                  onClick={() => setShowCalendar(true)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setShowCalendar(true);
                    }
                  }}
                />
                <Popover open={showCalendar} onOpenChange={setShowCalendar}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      className="absolute top-1/2 right-2 size-6 -translate-y-1/2 pointer-events-none"
                    >
                      <CalendarIcon className="size-3.5" />
                      <span className="sr-only">{t.crm.deals.detailsModal.selectDateScreenReader}</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-auto overflow-hidden p-0"
                    align="end"
                    alignOffset={-8}
                    sideOffset={10}
                  >
                    <Calendar
                      mode="single"
                      selected={expectedCloseDate}
                      captionLayout="dropdown"
                      onSelect={(date) => {
                        setExpectedCloseDate(date);
                        setDateValue(formatDate(date));
                        setShowCalendar(false);
                      }}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">{t.crm.deals.detailsModal.notesLabel}</Label>
            <Textarea
              id="notes"
              placeholder={t.crm.deals.detailsModal.notesPlaceholder}
              className="min-h-[80px] resize-none"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <div>
            {onDelete && (
              <>
                <Button
                  variant="outline"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10 hover:border-destructive/15"
                  disabled={loading}
                  onClick={() => setShowDeleteConfirm(true)}
                >
                  {t.common.actions.delete}
                </Button>
                <ConfirmDialog
                  open={showDeleteConfirm}
                  onOpenChange={setShowDeleteConfirm}
                  title={t.common.messages.confirmDelete}
                  description={st('sweep.weldcrm.editDealModal.deleteConfirmation')}
                  variant="destructive"
                  confirmLabel={t.common.actions.delete}
                  cancelLabel={t.common.actions.cancel}
                  onConfirm={handleDelete}
                />
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
              className="shadow-none"
            >
              {t.common.actions.cancel}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={loading || !dealTitle || !dealValue}
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t.common.actions.save}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
