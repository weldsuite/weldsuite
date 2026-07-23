
import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import {
  Plus,
  AlertCircle,
  Loader2,
  Info,
  Mail,
  ChevronLeft,
  CheckCircle2,
  Bolt,
  Globe,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import {
  useCreateMailAccount,
  useCheckWeldMailAvailability,
  useReserveWeldMailAddress,
  useWeldMailDomain,
} from '@/hooks/queries/use-mail-queries';
import { useDomains } from '@/hooks/queries/use-host-queries';
import { useAppAccess } from '@/hooks/use-app-access';
import { useCan } from '@weldsuite/permissions/react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

type AccountType = 'select' | 'resend' | 'weldmail';

interface SetupAddAccountProps {
  label?: string;
  disabled?: boolean;
}

export function SetupAddAccount({ label: labelProp, disabled = false }: SetupAddAccountProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const label = labelProp ?? st('sweep.weldmail.setup.addEmail');
  // RBAC: only members who can create mail accounts may add one. The backend
  // enforces `accounts:create` too — this hides the entry point entirely.
  const canCreateAccount = useCan('accounts:create');
  const createAccountMutation = useCreateMailAccount();
  const checkAvailabilityMutation = useCheckWeldMailAvailability();
  const reserveAddressMutation = useReserveWeldMailAddress();
  const weldMailDomainQuery = useWeldMailDomain();
  // Domains come straight from WeldHost — anything the workspace owns and
  // that's reached "active" status can host an email account.
  const hostDomainsQuery = useDomains({ status: 'active', pageSize: 100 });
  const { isInstalled: weldhostInstalled, isLoading: weldhostLoading } = useAppAccess('weldhost');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [accountType, setAccountType] = useState<AccountType>('select');

  // Custom domain state
  const [availableDomains, setAvailableDomains] = useState<string[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState('');
  const [emailPrefix, setEmailPrefix] = useState('');
  const [displayName, setDisplayName] = useState('');

  // WeldMail state
  const [weldmailAddress, setWeldmailAddress] = useState('');
  const [weldmailDisplayName, setWeldmailDisplayName] = useState('');
  const [weldmailDomain, setWeldmailDomain] = useState('');
  const [loadingDomain, setLoadingDomain] = useState(false);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const [availabilityResult, setAvailabilityResult] = useState<{
    available: boolean;
    message?: string;
  } | null>(null);

  // Sync WeldHost domains into the picker when the dialog opens.
  useEffect(() => {
    if (open && hostDomainsQuery.data?.domains) {
      const ready = hostDomainsQuery.data.domains
        .filter((d: any) => d.status === 'active' && d.fullDomain)
        .map((d: any) => d.fullDomain as string);
      setAvailableDomains(ready);
      if (ready.length > 0 && !selectedDomain) setSelectedDomain(ready[0]!);
    }
  }, [open, hostDomainsQuery.data]);

  // Sync WeldMail domain when switching to weldmail form
  useEffect(() => {
    if (accountType === 'weldmail' && !weldmailDomain && weldMailDomainQuery.data?.data?.domain) {
      setWeldmailDomain(weldMailDomainQuery.data.data.domain);
    }
  }, [accountType, weldmailDomain, weldMailDomainQuery.data]);

  // Debounced availability check
  useEffect(() => {
    const timer = setTimeout(() => {
      if (weldmailAddress && weldmailAddress.length >= 3) {
        setCheckingAvailability(true);
        checkAvailabilityMutation.mutateAsync(weldmailAddress)
          .then((result) => {
            setAvailabilityResult({
              available: result.available,
              message: result.message,
            });
          })
          .catch(() => setAvailabilityResult(null))
          .finally(() => setCheckingAvailability(false));
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [weldmailAddress]);

  const handleCustomDomainSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (!emailPrefix || !selectedDomain) {
        toast.error(t.mail.addAccount.pleaseEnterEmailAndDomain);
        setLoading(false);
        return;
      }
      // app-api resolves with the `{ data }` envelope on success and throws
      // on any non-2xx — so reaching the next line means the account was
      // created. (There is no `result.success` flag on the app-api response.)
      await createAccountMutation.mutateAsync({
        name: displayName || emailPrefix,
        email: `${emailPrefix}@${selectedDomain}`,
        displayName: displayName || emailPrefix,
      });
      toast.success(t.mail.addAccount.emailAccountCreatedSuccessfully);
      setOpen(false);
      window.dispatchEvent(new CustomEvent('mail-accounts-changed'));
    } catch {
      toast.error(t.mail.addAccount.failedToCreateEmailAccount);
    } finally {
      setLoading(false);
    }
  };

  const handleWeldmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (!weldmailAddress || weldmailAddress.length < 3) {
        toast.error(t.mail.addAccount.pleaseEnterAddress);
        setLoading(false);
        return;
      }
      if (!availabilityResult?.available) {
        toast.error(t.mail.addAccount.addressNotAvailableError);
        setLoading(false);
        return;
      }
      const result = await reserveAddressMutation.mutateAsync({
        address: weldmailAddress,
        name: weldmailDisplayName || weldmailAddress,
        displayName: weldmailDisplayName || weldmailAddress,
      });
      if (result.success) {
        toast.success(t.mail.addAccount.emailCreatedSuccessfully.replace('{email}', result.data?.email || weldmailAddress));
        setOpen(false);
        window.dispatchEvent(new CustomEvent('mail-accounts-changed'));
      } else {
        toast.error(t.mail.addAccount.failedToCreateWeldMail);
      }
    } catch {
      toast.error(t.mail.addAccount.unexpectedError);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      setAccountType('select');
      setEmailPrefix('');
      setDisplayName('');
      setWeldmailAddress('');
      setWeldmailDisplayName('');
      setWeldmailDomain('');
      setLoadingDomain(false);
      setAvailabilityResult(null);
    }
  };

  // Hide the entire "Add Email" entry point for members without create rights.
  if (!canCreateAccount) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8 shadow-none" disabled={disabled}>
          <Plus className="h-4 w-4 mr-0.5" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {accountType !== 'select' && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setAccountType('select')}
                className="p-1.5 rounded-md text-foreground hover:bg-muted transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
            {accountType === 'select'
              ? t.mail.addAccount.addEmailAccount
              : accountType === 'resend'
                ? t.mail.addAccount.createNewEmail
                : t.mail.addAccount.createWeldMailAddress}
          </DialogTitle>
        </DialogHeader>

        {/* Provider Selection */}
        {accountType === 'select' && (
          <div className="space-y-4">
            {/* Create new */}
            <div className="space-y-3">
              <p className="text-sm font-medium text-muted-foreground">
                {t.mail.addAccount.createNewEmailAddress}
              </p>
              <Button
                variant="outline"
                className="w-full h-14 px-3 justify-start gap-3 text-left font-normal rounded-lg"
                onClick={() => setAccountType('weldmail')}
              >
                <svg viewBox="0 0 937.21 669.01" className="size-7" fill="#f6663e">
                  <path d="M787.08,0H150.13C67.22,0,0,67.21,0,150.12v368.76c0,82.91,67.22,150.13,150.13,150.13h636.95c82.91,0,150.13-67.22,150.13-150.13V150.12C937.21,67.21,869.99,0,787.08,0ZM780.05,230.53l-180.95,138.23c-39.2,29.91-86.23,44.87-133.25,44.87s-93.98-14.96-133.19-44.87c-.11-.06-.17-.11-.28-.17l-175.45-136.42c-15.98-12.41-18.87-35.41-6.46-51.38,12.46-15.98,35.46-18.81,51.38-6.41l175.34,136.26c52.29,39.77,125.26,39.77,177.49-.06l180.95-138.23c16.04-12.3,39.04-9.18,51.27,6.85,12.3,16.09,9.24,39.03-6.85,51.33Z"/>
                </svg>
                <div className="flex flex-col items-start">
                  <span className="font-medium">{t.mail.addAccount.weldMailAddress}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.mail.addAccount.getFreeWeldMailAddress}
                  </span>
                </div>
              </Button>

              <Button
                variant="outline"
                className="w-full h-14 px-3 justify-start gap-3 text-left font-normal rounded-lg"
                onClick={() => setAccountType('resend')}
              >
                <Globe className="size-7 text-gray-500" />
                <div className="flex flex-col items-start">
                  <span className="font-medium">{t.mail.addAccount.customDomainEmail}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.mail.addAccount.useYourOwnDomain}
                  </span>
                </div>
              </Button>
            </div>
          </div>
        )}

        {/* WeldMail Form */}
        {accountType === 'weldmail' && (
          <form onSubmit={handleWeldmailSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="weldmail-address">{t.mail.addAccount.chooseYourAddress}</Label>
              <div className="flex gap-2">
                <Input
                  id="weldmail-address"
                  type="text"
                  placeholder="mycompany"
                  value={weldmailAddress}
                  onChange={(e) =>
                    setWeldmailAddress(
                      e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '')
                    )
                  }
                  required
                  className="flex-1"
                />
                <div className="flex items-center px-3 border rounded-md bg-muted min-w-[140px]">
                  {loadingDomain ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      @{weldmailDomain || 'weldmail.com'}
                    </span>
                  )}
                </div>
              </div>

              {weldmailAddress.length >= 3 && (
                <div className="flex items-center gap-2 text-sm">
                  {checkingAvailability ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      <span className="text-muted-foreground">
                        {t.mail.addAccount.checkingAvailability}
                      </span>
                    </>
                  ) : availabilityResult ? (
                    availabilityResult.available ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                        <span className="text-green-600">
                          {t.mail.addAccount.addressAvailable}
                        </span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="h-3.5 w-3.5 text-red-500" />
                        <span className="text-red-600">
                          {availabilityResult.message ||
                            t.mail.addAccount.addressNotAvailable}
                        </span>
                      </>
                    )
                  ) : null}
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {t.mail.addAccount.emailAddressWillBe}{' '}
                <strong>
                  {weldmailAddress || 'mycompany'}@
                  {weldmailDomain || 'weldmail.com'}
                </strong>
              </p>
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="weldmail-display-name"
                className="flex items-center gap-1.5"
              >
                {t.mail.addAccount.displayName}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t.mail.addAccount.displayNameTooltip}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <Input
                id="weldmail-display-name"
                type="text"
                placeholder={st('sweep.weldmail.setup.companyNamePlaceholder')}
                value={weldmailDisplayName}
                onChange={(e) => setWeldmailDisplayName(e.target.value)}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAccountType('select')}
                disabled={loading}
              >
                {t.mail.addAccount.cancel}
              </Button>
              <Button
                type="submit"
                disabled={loading || !availabilityResult?.available}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    {t.mail.addAccount.creating}
                  </>
                ) : (
                  t.mail.addAccount.createAddress
                )}
              </Button>
            </DialogFooter>
          </form>
        )}

        {/* Custom Domain Form */}
        {accountType === 'resend' && (
          <form onSubmit={handleCustomDomainSubmit} className="space-y-4">
            {loadingDomains ? (
              <div className="flex items-center justify-center gap-2 py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Loading...</span>
              </div>
            ) : availableDomains.length === 0 ? (
              weldhostLoading ? (
                <div className="flex items-center justify-center gap-2 py-8">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Loading...</span>
                </div>
              ) : !weldhostInstalled ? (
                <div className="space-y-3">
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      <div className="space-y-1">
                        <p className="font-medium text-foreground">
                          {t.mail.addAccount.weldHostRequired}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {t.mail.addAccount.weldHostRequiredDescription}
                        </p>
                      </div>
                    </AlertDescription>
                  </Alert>
                  <Button
                    type="button"
                    className="w-full"
                    onClick={() => window.location.href = '/appstore/weldhost'}
                  >
                    {t.mail.addAccount.installWeldHost}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {t.mail.addAccount.noActiveDomainsYet}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full h-14 px-3 justify-start gap-3 text-left font-normal rounded-lg"
                    onClick={() => window.location.href = '/weldhost/domains/external'}
                  >
                    <Bolt className="size-7 text-gray-500" />
                    <div className="flex flex-col items-start">
                      <span className="font-medium">{t.mail.addAccount.addExistingDomain}</span>
                      <span className="text-xs text-muted-foreground">{t.mail.addAccount.addExistingDomainDescription}</span>
                    </div>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full h-14 px-3 justify-start gap-3 text-left font-normal rounded-lg"
                    onClick={() => window.location.href = '/weldhost/domains/register'}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/assets/images/weldhost/logo-light.png" alt="WeldHost" className="size-7 dark:hidden" />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/assets/images/weldhost/logo-dark.png" alt="WeldHost" className="size-7 hidden dark:block" />
                    <div className="flex flex-col items-start">
                      <span className="font-medium">{t.mail.addAccount.buyNewDomain}</span>
                      <span className="text-xs text-muted-foreground">{t.mail.addAccount.buyNewDomainDescription}</span>
                    </div>
                  </Button>
                </div>
              )
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="domain">{t.mail.addAccount.selectDomain}</Label>
                  <Select
                    value={selectedDomain}
                    onValueChange={setSelectedDomain}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t.mail.addAccount.chooseDomain} />
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
                  <Label htmlFor="email-prefix">{t.mail.addAccount.emailName}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="email-prefix"
                      type="text"
                      placeholder="john.doe"
                      value={emailPrefix}
                      onChange={(e) =>
                        setEmailPrefix(
                          e.target.value
                            .toLowerCase()
                            .replace(/[^a-z0-9._-]/g, '')
                        )
                      }
                      required
                      className="flex-1"
                    />
                    <div className="flex items-center px-3 border rounded-md bg-muted">
                      <span className="text-sm text-muted-foreground">
                        @{selectedDomain}
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t.mail.addAccount.emailAddressWillBe}{' '}
                    <strong>
                      {emailPrefix || 'john.doe'}@{selectedDomain}
                    </strong>
                  </p>
                </div>

                <div className="space-y-2">
                  <Label
                    htmlFor="display-name"
                    className="flex items-center gap-1.5"
                  >
                    {t.mail.addAccount.displayName}
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{t.mail.addAccount.displayNameTooltip}</p>
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
              </>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAccountType('select')}
                disabled={loading}
              >
                {t.mail.addAccount.cancel}
              </Button>
              <Button
                type="submit"
                disabled={loading || availableDomains.length === 0}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    {t.mail.addAccount.creating}
                  </>
                ) : (
                  t.mail.addAccount.createEmail
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
