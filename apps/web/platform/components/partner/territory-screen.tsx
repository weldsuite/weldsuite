/**
 * "WeldSuite in {country} is provided by {partner}": shown when creating a
 * workspace (or starting a subscription) from a country a partner serves.
 * The person can contact the partner or leave a request that lands in the
 * partner's portal.
 */

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useUser } from '@clerk/clerk-react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { PartnerTerritoryErrorDetails } from '@weldsuite/app-api-client/schemas/partners';
import { useSubmitPartnerRequest } from '@/hooks/queries/use-partner-queries';
import { COUNTRIES } from '@/lib/constants/countries';
import { apiErrorCode } from '@/lib/partner/api-errors';
import { useI18n } from '@/lib/i18n/provider';
import { PartnerContactLinks, PartnerLogo } from './partner-contact';

const requestSchema = z.object({
  companyName: z.string().trim().min(1).max(255),
  message: z.string().trim().max(2000),
});
type RequestValues = z.infer<typeof requestSchema>;

/** The country's name in the user's language, falling back to the English list. */
export function useCountryName() {
  const { language } = useI18n();
  return (code: string): string => {
    try {
      const name = new Intl.DisplayNames([language], { type: 'region' }).of(code);
      if (name && name !== code) return name;
    } catch {
      // Intl.DisplayNames unavailable or code rejected — use the static list.
    }
    return COUNTRIES.find((c) => c.code === code)?.name ?? code;
  };
}

interface TerritoryScreenProps {
  details: PartnerTerritoryErrorDetails;
  /** Pre-filled company, e.g. the workspace name the person typed. */
  defaultCompany?: string;
  /** Apps chosen before the request, passed on to the partner. */
  selectedApps?: string[];
  /** Back to the form the person came from (the create dialog). Omit when there is none. */
  onBack?: () => void;
  onClose: () => void;
}

export function TerritoryScreen({ details, defaultCompany = '', selectedApps = [], onBack, onClose }: Readonly<TerritoryScreenProps>) {
  const { t, format } = useI18n();
  const tt = t.partner.territory;
  const countryName = useCountryName();
  const submit = useSubmitPartnerRequest();
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? '';
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { partner } = details;

  const form = useForm<RequestValues>({
    resolver: zodResolver(requestSchema),
    defaultValues: { companyName: defaultCompany, message: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);
    try {
      await submit.mutateAsync({
        companyName: values.companyName,
        country: details.country,
        selectedApps,
        ...(values.message ? { message: values.message } : {}),
      });
      setSent(true);
    } catch (err) {
      // The daily request limit has its own, more useful message.
      setFailure(apiErrorCode(err) === 'RATE_LIMITED' && err instanceof Error ? err.message : tt.failed);
    }
  });

  if (sent) {
    return (
      <div className="space-y-4 py-2 text-center" role="status">
        <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <h3 className="text-lg font-semibold">{tt.sentTitle}</h3>
        <p className="text-sm text-muted-foreground">{format(tt.sentDescription, { partner: partner.name, email })}</p>
        <Button onClick={onClose}>{tt.done}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <PartnerLogo partner={partner} className="h-12 w-12" />
        <div className="min-w-0">
          <h3 className="text-lg font-semibold leading-tight">
            {format(tt.title, { country: countryName(details.country), partner: partner.name })}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{format(tt.description, { partner: partner.name })}</p>
        </div>
      </div>

      <PartnerContactLinks partner={partner} />

      <form onSubmit={onSubmit} className="space-y-4 rounded-xl border p-4" noValidate>
        <div>
          <h4 className="text-sm font-semibold">{tt.requestHeading}</h4>
          <p className="text-xs text-muted-foreground">{format(tt.requestDescription, { partner: partner.name })}</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="territory-company">{tt.company}</Label>
          <Input
            id="territory-company"
            placeholder={tt.companyPlaceholder}
            disabled={submit.isPending}
            aria-invalid={Boolean(form.formState.errors.companyName)}
            {...form.register('companyName')}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="territory-message">{tt.message}</Label>
          <Textarea
            id="territory-message"
            rows={3}
            placeholder={tt.messagePlaceholder}
            disabled={submit.isPending}
            {...form.register('message')}
          />
        </div>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {onBack && (
            <Button type="button" variant="outline" onClick={onBack} disabled={submit.isPending}>
              {tt.back}
            </Button>
          )}
          <Button type="submit" disabled={submit.isPending}>
            {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {submit.isPending ? tt.submitting : tt.submit}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** The same screen as a standalone dialog (checkout and plan pages). */
export function TerritoryDialog({
  open,
  onOpenChange,
  details,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; details: PartnerTerritoryErrorDetails | null }>) {
  const { t, format } = useI18n();
  const countryName = useCountryName();
  if (!details) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="sr-only">
          <DialogTitle>
            {format(t.partner.territory.title, { country: countryName(details.country), partner: details.partner.name })}
          </DialogTitle>
          <DialogDescription>{format(t.partner.territory.description, { partner: details.partner.name })}</DialogDescription>
        </DialogHeader>
        <TerritoryScreen details={details} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
