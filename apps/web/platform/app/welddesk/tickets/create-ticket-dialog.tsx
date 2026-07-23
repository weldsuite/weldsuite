import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@weldsuite/ui/components/dialog';
import { TicketTypeSelectorInline } from '@/components/welddesk/ticket-type-selector';
import { DynamicTicketForm } from '@/components/welddesk/dynamic-ticket-form';
import type { TicketTypeConfig } from '@/hooks/queries/use-helpdesk-queries';
import { useI18n } from '@/lib/i18n/provider';

interface CreateTicketDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTicketCreated?: (ticketId: string) => void;
  prefillData?: {
    subject?: string;
    customerEmail?: string;
    customerName?: string;
    description?: string;
  };
}

export function CreateTicketDialog({
  open,
  onOpenChange,
  onTicketCreated,
  prefillData,
}: CreateTicketDialogProps) {
  const { t } = useI18n();
  const ctd = t.helpdesk.createTicketDialog;
  const [step, setStep] = useState<'select' | 'form'>('select');
  const [selectedType, setSelectedType] = useState<TicketTypeConfig | null>(null);

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setStep('select');
      setSelectedType(null);
    }
    onOpenChange(isOpen);
  };

  const handleSelectType = (type: TicketTypeConfig) => {
    setSelectedType(type);
    setStep('form');
  };

  const handleBack = () => {
    setStep('select');
    setSelectedType(null);
  };

  const handleSuccess = (ticketId?: string) => {
    if (ticketId) onTicketCreated?.(ticketId);
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {step === 'select' ? (
        <DialogContent className="sm:max-w-xl overflow-hidden p-0 gap-0" showCloseButton={false}>
          <DialogHeader className="sr-only">
            <DialogTitle>{ctd.selectTypeTitle}</DialogTitle>
            <DialogDescription>{ctd.selectTypeDescription}</DialogDescription>
          </DialogHeader>
          <TicketTypeSelectorInline onSelect={handleSelectType} />
        </DialogContent>
      ) : (
        <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{ctd.createTitle}</DialogTitle>
          </DialogHeader>
          <DynamicTicketForm
            ticketType={selectedType}
            onBack={handleBack}
            onSuccess={handleSuccess}
            prefillData={prefillData}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}
