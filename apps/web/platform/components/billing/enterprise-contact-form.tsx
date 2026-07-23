
import { useState } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Label } from '@weldsuite/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Loader2, Building2, CheckCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { useAppApiClient } from '@/lib/api/use-app-api';

interface EnterpriseContactFormProps {
  trigger?: React.ReactNode;
  onSuccess?: () => void;
}

export function EnterpriseContactForm({ trigger, onSuccess }: EnterpriseContactFormProps) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { getClient } = useAppApiClient();

  const [formData, setFormData] = useState({
    companyName: '',
    contactName: '',
    contactEmail: '',
    teamSize: '',
    useCase: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const client = await getClient();
      // `/billing/enterprise-inquiry` never existed on any worker, so this form
      // always 404'd. The endpoint is now built on app-api (it emails the sales
      // inbox) and answers the standard `{ data }` envelope; the client throws on
      // a non-2xx, so reaching this line means the inquiry was accepted.
      await client.post<{ data: { success: boolean } }>('/billing/enterprise-inquiry', {
        companyName: formData.companyName,
        contactName: formData.contactName,
        contactEmail: formData.contactEmail,
        teamSize: formData.teamSize,
        useCase: formData.useCase,
        source: 'pricing_dialog',
      });

      setSubmitted(true);
      onSuccess?.();

      // Reset form after delay
      setTimeout(() => {
        setOpen(false);
        setSubmitted(false);
        setFormData({
          companyName: '',
          contactName: '',
          contactEmail: '',
          teamSize: '',
          useCase: '',
        });
      }, 3000);
    } catch (err: any) {
      setError(err.message || t('sweep.settings.enterpriseContact.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const teamSizeOptions = [
    { value: '10-50', label: t('sweep.settings.enterpriseContact.employees10to50') },
    { value: '51-200', label: t('sweep.settings.enterpriseContact.employees51to200') },
    { value: '201-500', label: t('sweep.settings.enterpriseContact.employees201to500') },
    { value: '501-1000', label: t('sweep.settings.enterpriseContact.employees501to1000') },
    { value: '1000+', label: t('sweep.settings.enterpriseContact.employees1000plus') },
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" className="gap-2">
            <Building2 className="h-4 w-4" />
            {t('sweep.settings.enterpriseContact.contactSales')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t('sweep.settings.enterpriseContact.contactSales')}</DialogTitle>
          <DialogDescription>
            {t('sweep.settings.enterpriseContact.description')}
          </DialogDescription>
        </DialogHeader>

        {submitted ? (
          <div className="py-8 text-center">
            <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">{t('sweep.settings.enterpriseContact.thankYou')}</h3>
            <p className="text-muted-foreground">
              {t('sweep.settings.enterpriseContact.receivedInquiry')}
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="companyName">{t('sweep.settings.enterpriseContact.companyName')} *</Label>
                <Input
                  id="companyName"
                  placeholder="Acme Inc."
                  value={formData.companyName}
                  onChange={(e) => setFormData({ ...formData, companyName: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="teamSize">{t('sweep.settings.enterpriseContact.teamSize')} *</Label>
                <Select
                  value={formData.teamSize}
                  onValueChange={(value) => setFormData({ ...formData, teamSize: value })}
                  required
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('sweep.settings.enterpriseContact.selectSize')} />
                  </SelectTrigger>
                  <SelectContent>
                    {teamSizeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="contactName">{t('sweep.settings.enterpriseContact.yourName')} *</Label>
                <Input
                  id="contactName"
                  placeholder="John Smith"
                  value={formData.contactName}
                  onChange={(e) => setFormData({ ...formData, contactName: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactEmail">{t('sweep.settings.enterpriseContact.workEmail')} *</Label>
                <Input
                  id="contactEmail"
                  type="email"
                  placeholder="john@acme.com"
                  value={formData.contactEmail}
                  onChange={(e) => setFormData({ ...formData, contactEmail: e.target.value })}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="useCase">{t('sweep.settings.enterpriseContact.useCase')}</Label>
              <Textarea
                id="useCase"
                placeholder={t('sweep.settings.enterpriseContact.useCasePlaceholder')}
                value={formData.useCase}
                onChange={(e) => setFormData({ ...formData, useCase: e.target.value })}
                rows={4}
              />
            </div>

            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t('sweep.settings.enterpriseContact.cancel')}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t('sweep.settings.enterpriseContact.submitInquiry')}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
