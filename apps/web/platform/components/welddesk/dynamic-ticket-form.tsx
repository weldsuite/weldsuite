import { useState, useEffect, useMemo } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useUser } from '@clerk/clerk-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCreateTicket } from '@/hooks/queries/use-helpdesk-queries';
import type { TicketTypeConfig, TicketTypeField } from '@/hooks/queries/use-helpdesk-queries';

interface DynamicTicketFormProps {
  ticketType: TicketTypeConfig | null;
  onBack?: () => void;
  onSuccess: (ticketId?: string) => void;
  conversationId?: string;
  prefillData?: {
    subject?: string;
    customerEmail?: string;
    customerName?: string;
    description?: string;
  };
}

export function DynamicTicketForm({
  ticketType,
  onBack,
  onSuccess,
  conversationId,
  prefillData,
}: DynamicTicketFormProps) {
  const t = useTranslations();
  const createTicket = useCreateTicket();
  const { user } = useUser();
  const isBackOffice = ticketType?.category === 'back-office';

  const [subject, setSubject] = useState(prefillData?.subject || '');
  const [description, setDescription] = useState(prefillData?.description || '');
  const [customerName, setCustomerName] = useState(prefillData?.customerName || '');
  const [customerEmail, setCustomerEmail] = useState(prefillData?.customerEmail || '');
  const [priority, setPriority] = useState(ticketType?.defaultPriority || 'normal');
  const [customFields, setCustomFields] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Auto-fill customer info for back-office tickets
  useEffect(() => {
    if (isBackOffice && user) {
      if (!prefillData?.customerName) setCustomerName(user.fullName || user.firstName || '');
      if (!prefillData?.customerEmail) setCustomerEmail(user.primaryEmailAddress?.emailAddress || '');
    }
  }, [isBackOffice, user, prefillData]);

  const fields = useMemo(() => {
    return (ticketType?.fields || [])
      .filter((f) => !f.isDefault && f.teammateVisible !== false)
      .sort((a, b) => a.order - b.order);
  }, [ticketType]);

  const updateCustomField = (key: string, value: any) => {
    setCustomFields((prev) => ({ ...prev, [key]: value }));
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!isBackOffice) {
      if (!customerName.trim()) newErrors.customerName = t('sweep.welddesk.dynamicTicketForm.requiredError');
      if (!customerEmail.trim()) {
        newErrors.customerEmail = t('sweep.welddesk.dynamicTicketForm.requiredError');
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
        newErrors.customerEmail = t('sweep.welddesk.dynamicTicketForm.invalidEmailError');
      }
    }
    if (!subject.trim()) newErrors.subject = t('sweep.welddesk.dynamicTicketForm.requiredError');

    for (const field of fields) {
      if (field.required) {
        const value = customFields[field.key];
        if (value === undefined || value === null || value === '') {
          newErrors[field.key] = t('sweep.welddesk.dynamicTicketForm.requiredError');
        }
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) {
      toast.error(t('sweep.welddesk.dynamicTicketForm.fillRequiredFields'));
      return;
    }

    try {
      const result = await createTicket.mutateAsync({
        subject,
        description,
        customerName: customerName || user?.fullName || '',
        customerEmail: customerEmail || user?.primaryEmailAddress?.emailAddress || '',
        priority,
        ticketTypeId: ticketType?.id,
        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
        conversationId,
      });

      if (result.success) {
        toast.success(t('sweep.welddesk.dynamicTicketForm.ticketCreatedSuccess'));
        onSuccess(result.data?.id);
      }
    } catch (err) {
      toast.error(t('sweep.welddesk.dynamicTicketForm.ticketCreateFailed'));
    }
  };

  const renderField = (field: TicketTypeField) => {
    const value = customFields[field.key] ?? '';
    const hasError = !!errors[field.key];

    switch (field.type) {
      case 'text':
      case 'email':
      case 'url':
        return (
          <Input
            type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
            value={value}
            onChange={(e) => updateCustomField(field.key, e.target.value)}
            placeholder={field.placeholder}
            className={hasError ? 'border-destructive' : ''}
          />
        );

      case 'number':
        return (
          <Input
            type="number"
            value={value}
            onChange={(e) => updateCustomField(field.key, e.target.value)}
            placeholder={field.placeholder}
            className={hasError ? 'border-destructive' : ''}
          />
        );

      case 'textarea':
        return (
          <Textarea
            value={value}
            onChange={(e) => updateCustomField(field.key, e.target.value)}
            placeholder={field.placeholder}
            rows={3}
            className={hasError ? 'border-destructive' : ''}
          />
        );

      case 'select':
        return (
          <Select value={value} onValueChange={(v) => updateCustomField(field.key, v)}>
            <SelectTrigger className={hasError ? 'border-destructive' : ''}>
              <SelectValue placeholder={field.placeholder || t('sweep.welddesk.dynamicTicketForm.selectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {(field.options || []).map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case 'multiselect': {
        const selected: string[] = Array.isArray(value) ? value : [];
        return (
          <div className="space-y-1.5">
            {(field.options || []).map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={selected.includes(opt.value)}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      updateCustomField(field.key, [...selected, opt.value]);
                    } else {
                      updateCustomField(field.key, selected.filter((v) => v !== opt.value));
                    }
                  }}
                />
                {opt.label}
              </label>
            ))}
          </div>
        );
      }

      case 'date':
        return (
          <Input
            type="date"
            value={value}
            onChange={(e) => updateCustomField(field.key, e.target.value)}
            className={hasError ? 'border-destructive' : ''}
          />
        );

      case 'checkbox':
        return (
          <div className="flex items-center gap-2">
            <Checkbox
              checked={!!value}
              onCheckedChange={(checked) => updateCustomField(field.key, !!checked)}
            />
            <span className="text-sm text-muted-foreground">
              {field.placeholder || field.label}
            </span>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Back button + type name */}
      {onBack && (
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            {t('sweep.welddesk.dynamicTicketForm.back')}
          </Button>
          {ticketType && (
            <span className="text-sm text-muted-foreground">
              {t('sweep.welddesk.dynamicTicketForm.creatingLabel')} <span className="font-medium text-foreground">{ticketType.name}</span>
            </span>
          )}
        </div>
      )}

      {/* Standard fields — hidden for back-office tickets */}
      {!isBackOffice && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{t('sweep.welddesk.dynamicTicketForm.nameLabel')} <span className="text-destructive">*</span></Label>
            <Input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder={t('sweep.welddesk.dynamicTicketForm.namePlaceholder')}
              className={errors.customerName ? 'border-destructive' : ''}
            />
            {errors.customerName && <p className="text-xs text-destructive">{errors.customerName}</p>}
          </div>
          <div className="space-y-2">
            <Label>{t('sweep.welddesk.dynamicTicketForm.emailLabel')} <span className="text-destructive">*</span></Label>
            <Input
              type="email"
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              placeholder={t('sweep.welddesk.dynamicTicketForm.emailPlaceholder')}
              className={errors.customerEmail ? 'border-destructive' : ''}
            />
            {errors.customerEmail && <p className="text-xs text-destructive">{errors.customerEmail}</p>}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label>{t('sweep.welddesk.dynamicTicketForm.subjectLabel')} <span className="text-destructive">*</span></Label>
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={t('sweep.welddesk.dynamicTicketForm.subjectPlaceholder')}
          className={errors.subject ? 'border-destructive' : ''}
        />
        {errors.subject && <p className="text-xs text-destructive">{errors.subject}</p>}
      </div>

      <div className="space-y-2">
        <Label>{t('sweep.welddesk.dynamicTicketForm.descriptionLabel')}</Label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('sweep.welddesk.dynamicTicketForm.descriptionPlaceholder')}
          rows={4}
        />
      </div>

      <div className="space-y-2">
        <Label>{t('sweep.welddesk.dynamicTicketForm.priorityLabel')}</Label>
        <Select value={priority} onValueChange={setPriority}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">{t('sweep.welddesk.dynamicTicketForm.priorityLow')}</SelectItem>
            <SelectItem value="normal">{t('sweep.welddesk.dynamicTicketForm.priorityNormal')}</SelectItem>
            <SelectItem value="high">{t('sweep.welddesk.dynamicTicketForm.priorityHigh')}</SelectItem>
            <SelectItem value="urgent">{t('sweep.welddesk.dynamicTicketForm.priorityUrgent')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Custom fields from ticket type */}
      {fields.length > 0 && (
        <div className="space-y-4 pt-2 border-t">
          <p className="text-sm font-medium text-muted-foreground">{t('sweep.welddesk.dynamicTicketForm.additionalInformation')}</p>
          {fields.map((field) => (
            <div key={field.key} className="space-y-2">
              <Label>
                {field.label}
                {field.required && <span className="text-destructive"> *</span>}
              </Label>
              {renderField(field)}
              {field.helpText && (
                <p className="text-xs text-muted-foreground">{field.helpText}</p>
              )}
              {errors[field.key] && (
                <p className="text-xs text-destructive">{errors[field.key]}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={createTicket.isPending}>
          {createTicket.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          {t('sweep.welddesk.dynamicTicketForm.createTicketButton')}
        </Button>
      </div>
    </form>
  );
}
