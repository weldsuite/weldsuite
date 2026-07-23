
import { useState, useEffect } from 'react';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useMailAccounts } from '@/hooks/queries/use-mail-queries';
import { PageLoader } from '@/components/page-loader';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import {
  Loader2,
  Info,
  CheckCircle2,
  AlertCircle,
  Bolt,
} from 'lucide-react';
import { AppIcon } from '@/components/app-icon';
import {
  useCreateMailAccount,
  useCheckWeldMailAvailability,
  useReserveWeldMailAddress,
  useWeldMailDomain,
  useMailDomains,
} from '@/hooks/queries/use-mail-queries';
import { toast } from 'sonner';

type SetupMethod = 'select' | 'weldmail' | 'custom-domain';

// --- Icons ---

const WELDMAIL_ICON = (
  <svg viewBox="0 0 937.21 669.01" className="size-7" fill="#f6663e">
    <path d="M787.08,0H150.13C67.22,0,0,67.21,0,150.12v368.76c0,82.91,67.22,150.13,150.13,150.13h636.95c82.91,0,150.13-67.22,150.13-150.13V150.12C937.21,67.21,869.99,0,787.08,0ZM780.05,230.53l-180.95,138.23c-39.2,29.91-86.23,44.87-133.25,44.87s-93.98-14.96-133.19-44.87c-.11-.06-.17-.11-.28-.17l-175.45-136.42c-15.98-12.41-18.87-35.41-6.46-51.38,12.46-15.98,35.46-18.81,51.38-6.41l175.34,136.26c52.29,39.77,125.26,39.77,177.49-.06l180.95-138.23c16.04-12.3,39.04-9.18,51.27,6.85,12.3,16.09,9.24,39.03-6.85,51.33Z" />
  </svg>
);

// --- Step Content Components ---

function ChooseMethodContent({
  onSelectMethod,
}: {
  onSelectMethod: (method: SetupMethod) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">
          {t.mail.setupPage.createNewEmailAddress}
        </p>
        <Button
          variant="outline"
          className="w-full h-14 px-3 justify-start gap-3 text-left font-normal rounded-lg"
          onClick={() => onSelectMethod('weldmail')}
        >
          {WELDMAIL_ICON}
          <div className="flex flex-col items-start">
            <span className="font-medium">{t.mail.setupPage.weldMailAddress}</span>
            <span className="text-xs text-muted-foreground">{t.mail.setupPage.getFreeWeldMailAddress}</span>
          </div>
        </Button>

        <Button
          variant="outline"
          className="w-full h-14 px-3 justify-start gap-3 text-left font-normal rounded-lg"
          onClick={() => onSelectMethod('custom-domain')}
        >
          <AppIcon icon="weldhost" className="size-7" />
          <div className="flex flex-col items-start">
            <span className="font-medium">{t.mail.setupPage.customDomainEmail}</span>
            <span className="text-xs text-muted-foreground">{t.mail.setupPage.useYourOwnDomain}</span>
          </div>
        </Button>
      </div>
    </div>
  );
}

function WeldMailContent({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useI18n();
  const st = useTranslations();
  const reserveAddressMutation = useReserveWeldMailAddress();
  const checkAvailabilityMutation = useCheckWeldMailAvailability();
  const weldMailDomainQuery = useWeldMailDomain();

  const [loading, setLoading] = useState(false);
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [domain, setDomain] = useState('');
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const [availabilityResult, setAvailabilityResult] = useState<{
    available: boolean;
    message?: string;
  } | null>(null);

  useEffect(() => {
    if (!domain && weldMailDomainQuery.data?.data?.domain) {
      setDomain(weldMailDomainQuery.data.data.domain);
    }
  }, [domain, weldMailDomainQuery.data]);

  useEffect(() => {
    if (!address || address.length < 3) {
      setAvailabilityResult(null);
      return;
    }
    const timer = setTimeout(() => {
      setCheckingAvailability(true);
      checkAvailabilityMutation
        .mutateAsync(address)
        .then((result) => {
          setAvailabilityResult({ available: result.available, message: result.message });
        })
        .catch(() => setAvailabilityResult(null))
        .finally(() => setCheckingAvailability(false));
    }, 500);
    return () => clearTimeout(timer);
  }, [address]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address || address.length < 3) {
      toast.error(t.mail.setupPage.pleaseEnterAddress);
      return;
    }
    if (!availabilityResult?.available) {
      toast.error(t.mail.setupPage.addressNotAvailableError);
      return;
    }
    setLoading(true);
    try {
      const result = await reserveAddressMutation.mutateAsync({
        address,
        name: displayName || address,
        displayName: displayName || address,
      });
      if (result.success) {
        toast.success(t.mail.setupPage.emailCreatedSuccessfully.replace('{email}', result.data?.email || address));
        window.dispatchEvent(new CustomEvent('mail-accounts-changed'));
        onSuccess();
      } else {
        toast.error(t.mail.setupPage.failedToCreateWeldMail);
      }
    } catch {
      toast.error(t.mail.setupPage.unexpectedError);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col flex-1 gap-4">
      <div className="space-y-2">
        <Label htmlFor="weldmail-address">{t.mail.setupPage.chooseYourAddress}</Label>
        <div className="flex gap-2">
          <Input
            id="weldmail-address"
            type="text"
            placeholder="mycompany"
            value={address}
            onChange={(e) => setAddress(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
            required
            className="flex-1"
          />
          <div className="flex items-center px-3 border rounded-md bg-muted min-w-[140px]">
            {weldMailDomainQuery.isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            ) : (
              <span className="text-sm text-muted-foreground">@{domain || 'weldmail.com'}</span>
            )}
          </div>
        </div>

        {address.length >= 3 && (
          <div className="flex items-center gap-2 text-sm">
            {checkingAvailability ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground">{t.mail.setupPage.checkingAvailability}</span>
              </>
            ) : availabilityResult ? (
              availabilityResult.available ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                  <span className="text-green-600">{t.mail.setupPage.addressAvailable}</span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-3.5 w-3.5 text-red-500" />
                  <span className="text-red-600">
                    {availabilityResult.message || t.mail.setupPage.addressNotAvailable}
                  </span>
                </>
              )
            ) : null}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {t.mail.setupPage.emailAddressWillBe}{' '}
          <strong>{address || 'mycompany'}@{domain || 'weldmail.com'}</strong>
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="weldmail-display-name" className="flex items-center gap-1.5">
          {t.mail.setupPage.displayName}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t.mail.setupPage.displayNameTooltip}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </Label>
        <Input
          id="weldmail-display-name"
          type="text"
          placeholder={st('sweep.weldmail.setup.companyNamePlaceholder')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>

      <Button
        type="submit"
        disabled={loading || !availabilityResult?.available}
        className="w-full mt-auto"
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            {t.mail.setupPage.creating}
          </>
        ) : (
          t.mail.setupPage.createAddress
        )}
      </Button>
    </form>
  );
}

function CustomDomainContent({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useI18n();
  const st = useTranslations();
  const createAccountMutation = useCreateMailAccount();
  const mailDomainsQuery = useMailDomains();

  const [loading, setLoading] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState('');
  const [emailPrefix, setEmailPrefix] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [availableDomains, setAvailableDomains] = useState<string[]>([]);

  useEffect(() => {
    if (mailDomainsQuery.data?.data) {
      const verified = mailDomainsQuery.data.data
        .filter((d: any) => d.dnsStatus === 'verified' && d.isActive)
        .map((d: any) => d.domainName);
      setAvailableDomains(verified);
      if (verified.length > 0 && !selectedDomain) setSelectedDomain(verified[0]);
    }
  }, [mailDomainsQuery.data]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailPrefix || !selectedDomain) {
      toast.error(t.mail.setupPage.pleaseEnterEmailAndDomain);
      return;
    }
    setLoading(true);
    try {
      const result = await createAccountMutation.mutateAsync({
        email: `${emailPrefix}@${selectedDomain}`,
        displayName: displayName || emailPrefix,
      });
      if (result.success) {
        toast.success(t.mail.setupPage.emailAccountCreatedSuccessfully);
        window.dispatchEvent(new CustomEvent('mail-accounts-changed'));
        onSuccess();
      } else {
        toast.error(t.mail.setupPage.failedToCreateEmailAccount);
      }
    } catch {
      toast.error(t.mail.setupPage.unexpectedError);
    } finally {
      setLoading(false);
    }
  };

  if (mailDomainsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (availableDomains.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t.mail.setupPage.noDomainsConfigured}
        </p>
        <Button
          type="button"
          variant="outline"
          className="w-full h-14 px-3 justify-start gap-3 text-left font-normal rounded-lg"
          onClick={() => (window.location.href = '/settings/apps/weldmail')}
        >
          <Bolt className="size-7 text-gray-500" />
          <div className="flex flex-col items-start">
            <span className="font-medium">{t.mail.setupPage.configureDomain}</span>
            <span className="text-xs text-muted-foreground">{t.mail.setupPage.configureDomainDescription}</span>
          </div>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="w-full h-14 px-3 justify-start gap-3 text-left font-normal rounded-lg"
          onClick={() => (window.location.href = '/weldhost/domains/register')}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/images/weldhost/logo-light.png" alt="WeldHost" className="size-7 dark:hidden" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/images/weldhost/logo-dark.png" alt="WeldHost" className="size-7 hidden dark:block" />
          <div className="flex flex-col items-start">
            <span className="font-medium">{t.mail.setupPage.buyNewDomain}</span>
            <span className="text-xs text-muted-foreground">{t.mail.setupPage.buyNewDomainDescription}</span>
          </div>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="domain">{t.mail.setupPage.selectDomain}</Label>
        <Select value={selectedDomain} onValueChange={setSelectedDomain}>
          <SelectTrigger>
            <SelectValue placeholder={t.mail.setupPage.chooseDomain} />
          </SelectTrigger>
          <SelectContent>
            {availableDomains.map((domain) => (
              <SelectItem key={domain} value={domain}>
                {domain}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="email-prefix">{t.mail.setupPage.emailName}</Label>
        <div className="flex gap-2">
          <Input
            id="email-prefix"
            type="text"
            placeholder="john.doe"
            value={emailPrefix}
            onChange={(e) => setEmailPrefix(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
            required
            className="flex-1"
          />
          <div className="flex items-center px-3 border rounded-md bg-muted">
            <span className="text-sm text-muted-foreground">@{selectedDomain}</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t.mail.setupPage.emailAddressWillBe}{' '}
          <strong>{emailPrefix || 'john.doe'}@{selectedDomain}</strong>
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="display-name" className="flex items-center gap-1.5">
          {t.mail.setupPage.displayName}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t.mail.setupPage.displayNameTooltip}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </Label>
        <Input
          id="display-name"
          type="text"
          placeholder={st('sweep.weldmail.setup.personNamePlaceholder')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>

      <Button type="submit" disabled={loading || availableDomains.length === 0} className="w-full">
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            {t.mail.setupPage.creating}
          </>
        ) : (
          t.mail.setupPage.createEmail
        )}
      </Button>
    </form>
  );
}

// --- Main Page ---

export default function MailSetupPage() {
  const { t } = useI18n();
  const router = useRouter();

  const { data: accountsData, isLoading } = useMailAccounts();
  const emailAccounts = accountsData?.data || [];

  const [method, setMethod] = useState<SetupMethod>('select');

  useEffect(() => {
    if (!isLoading && emailAccounts.length > 0) {
      const defaultAccount = emailAccounts.find((acc: any) => acc.isDefault) || emailAccounts[0];
      router.replace(`/weldmail/${defaultAccount.id}/inbox`);
    }
  }, [isLoading, emailAccounts, router]);

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (emailAccounts.length > 0) {
    return <PageLoader fullScreen={false} />;
  }

  const handleSuccess = () => {
    router.push('/weldmail');
  };

  const dialogTitle =
    method === 'weldmail'
      ? t.mail.setupPage.createWeldMailAddress
      : t.mail.setupPage.customDomainEmail;

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100dvh-120px)] px-6">
      <div className="flex w-full max-w-sm flex-col gap-5">
        <div>
          <h3 className="text-2xl font-semibold tracking-tight">
            {t.mail.setupPage.connectYourEmail}
          </h3>
        </div>
        <ChooseMethodContent onSelectMethod={setMethod} />
      </div>

      {/* Selected method opens in a popup */}
      <Dialog
        open={method !== 'select'}
        onOpenChange={(open) => { if (!open) setMethod('select'); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            {method === 'custom-domain' && (
              <DialogDescription>{t.mail.setupPage.useYourOwnDomain}</DialogDescription>
            )}
          </DialogHeader>
          {method === 'weldmail' && <WeldMailContent onSuccess={handleSuccess} />}
          {method === 'custom-domain' && <CustomDomainContent onSuccess={handleSuccess} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
