import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useBankFeedInstitutions } from '@/hooks/queries/use-weldbooks-bank-feeds-queries';
import type { BankFeedProviderOption } from '@/lib/api/domains/weldbooks-bank-feeds';
import { useFeedTexts } from './feed-texts';

export interface ConnectSelection {
  provider: BankFeedProviderOption;
  institution?: { id?: string; name: string; country: string };
  psuType?: 'business' | 'personal';
}

/** A bank list this long is searched, not scrolled. */
const MAX_VISIBLE_INSTITUTIONS = 100;

/**
 * First step of a link when there is a choice to make: which provider to
 * connect with, and for providers that need the bank chosen up front (Enable
 * Banking) which bank. Plaid and Stripe pick the bank in their own window.
 */
export function ConnectBankDialog({
  open,
  onOpenChange,
  providers,
  country,
  onConnect,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: BankFeedProviderOption[];
  country: string;
  onConnect: (selection: ConnectSelection) => void;
}>) {
  const { t } = useFeedTexts();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.connect.title}</DialogTitle>
          <DialogDescription>{t.connect.description}</DialogDescription>
        </DialogHeader>
        <ConnectBankForm
          providers={providers}
          country={country}
          onCancel={() => onOpenChange(false)}
          onConnect={(selection) => {
            onOpenChange(false);
            onConnect(selection);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConnectBankForm({
  providers,
  country,
  onCancel,
  onConnect,
}: Readonly<{
  providers: BankFeedProviderOption[];
  country: string;
  onCancel: () => void;
  onConnect: (selection: ConnectSelection) => void;
}>) {
  const { t, format, providerName } = useFeedTexts();
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [institutionId, setInstitutionId] = useState('');
  const [psuType, setPsuType] = useState<'business' | 'personal'>('business');

  const provider = providers.find((p) => p.id === providerId) ?? providers[0];
  const needsInstitution = provider?.requiresInstitution === true;
  const institutions = useBankFeedInstitutions(provider?.id, country, { enabled: needsInstitution });

  const visibleInstitutions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = institutions.data ?? [];
    const matches = needle ? all.filter((i) => i.name.toLowerCase().includes(needle)) : all;
    return matches.slice(0, MAX_VISIBLE_INSTITUTIONS);
  }, [institutions.data, query]);

  const institution = (institutions.data ?? []).find((i) => i.id === institutionId);
  const canContinue = !!provider && (!needsInstitution || !!institution);

  const submit = () => {
    if (!provider || !canContinue) return;
    onConnect({
      provider,
      ...(needsInstitution && institution
        ? { institution: { id: institution.id, name: institution.name, country: institution.country || country }, psuType }
        : {}),
    });
  };

  return (
    <>
      <div className="space-y-4">
        {providers.length > 1 ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t.connect.providerLabel}</legend>
            <RadioGroup
              value={providerId}
              onValueChange={(value) => {
                setProviderId(value);
                setInstitutionId('');
                setQuery('');
              }}
              aria-label={t.connect.providerLabel}
            >
              {providers.map((option) => (
                <Label
                  key={option.id}
                  htmlFor={`bank-feed-provider-${option.id}`}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary"
                >
                  <RadioGroupItem value={option.id} id={`bank-feed-provider-${option.id}`} className="mt-0.5" />
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium">{providerName(option.id)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {format(t.connect.providerHistory, { days: option.capabilities.maxHistoryDays })}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </fieldset>
        ) : null}

        {needsInstitution ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="bank-feed-institution-search">{t.connect.institutionLabel}</Label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="bank-feed-institution-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t.connect.institutionSearch}
                  className="pl-9"
                  autoComplete="off"
                />
              </div>
            </div>

            {institutions.isLoading ? (
              <div className="space-y-2" aria-busy="true" aria-label={t.connect.institutionLoading}>
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : institutions.isError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  <span>{t.connect.institutionError}</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => institutions.refetch()}>
                    {t.list.retry}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : visibleInstitutions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{format(t.connect.institutionEmpty, { query })}</p>
            ) : (
              <RadioGroup
                value={institutionId}
                onValueChange={setInstitutionId}
                aria-label={t.connect.institutionList}
                className="max-h-60 gap-1 overflow-y-auto rounded-lg border p-1"
              >
                {visibleInstitutions.map((item) => (
                  // Bank ids are bank names: no DOM id, the label wraps its radio.
                  <Label
                    key={item.id}
                    className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 font-normal hover:bg-muted has-[[data-state=checked]]:bg-muted"
                  >
                    <RadioGroupItem value={item.id} />
                    <span className="text-sm">{item.name}</span>
                  </Label>
                ))}
              </RadioGroup>
            )}

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t.connect.accountHolderLabel}</legend>
              <RadioGroup
                value={psuType}
                onValueChange={(value) => setPsuType(value === 'personal' ? 'personal' : 'business')}
                aria-label={t.connect.accountHolderLabel}
                className="grid-cols-2"
              >
                {(['business', 'personal'] as const).map((type) => (
                  <Label
                    key={type}
                    htmlFor={`bank-feed-psu-${type}`}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary"
                  >
                    <RadioGroupItem value={type} id={`bank-feed-psu-${type}`} />
                    <span className="text-sm">{t.connect[type]}</span>
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>
          </div>
        ) : null}

        {provider?.kind === 'redirect' ? (
          <p className="text-sm text-muted-foreground">{t.connect.redirectNote}</p>
        ) : null}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t.connect.cancel}
        </Button>
        <Button type="button" disabled={!canContinue} onClick={submit}>
          {t.connect.continue}
        </Button>
      </DialogFooter>
    </>
  );
}
