
import { useTranslations } from '@weldsuite/i18n/client';
import { useEffect, useState, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useBlocker } from '@tanstack/react-router';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Separator } from '@weldsuite/ui/components/separator';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Loader2, Upload, Trash2, Check, ChevronsUpDown } from 'lucide-react';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { TIMEZONES } from '@/lib/timezones';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useWorkspaceSettings, useUpdateWorkspaceSettings } from '@/hooks/queries/use-settings-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { COUNTRIES } from '@/lib/constants/countries';
import { WorkspaceSlugCard } from './workspace-slug-card';
import { WorkspaceNameSection } from './workspace-name-section';
import { DeleteWorkspaceSection } from './delete-workspace-section';
import { useCurrentMember } from '@/hooks/use-current-member';

function getBusinessSettingsSchema(st: ReturnType<typeof useTranslations>) {
  return z.object({
    timezone: z.string().optional(),
    legalName: z.string().optional(),
    tradingName: z.string().optional(),
    contactFirstName: z.string().min(1, st('sweep.settings.business.validation.firstNameRequired')),
    contactLastName: z.string().min(1, st('sweep.settings.business.validation.lastNameRequired')),
    email: z.string().email(st('sweep.settings.business.validation.validEmailRequired')),
    phone: z.string().min(1, st('sweep.settings.business.validation.phoneRequired')),
    addressLine1: z.string().min(1, st('sweep.settings.business.validation.addressRequired')),
    addressLine2: z.string().optional(),
    city: z.string().min(1, st('sweep.settings.business.validation.cityRequired')),
    state: z.string().optional(),
    postalCode: z.string().min(1, st('sweep.settings.business.validation.postalCodeRequired')),
    countryCode: z.string().min(2, st('sweep.settings.business.validation.countryRequired')).max(2),
    taxId: z.string().optional(),
    registrationNumber: z.string().optional(),
  });
}

type BusinessSettingsValues = z.infer<ReturnType<typeof getBusinessSettingsSchema>>;

function LogoUpload({ currentLogoUrl, companyName, onLogoUploaded, onLogoRemoved }: {
  currentLogoUrl: string | null;
  companyName?: string;
  onLogoUploaded: (url: string) => void;
  onLogoRemoved: () => void;
}) {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initial = companyName?.trim() ? companyName.trim().charAt(0).toUpperCase() : 'L';

  const handleFile = async (file: File) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (!allowedTypes.includes(file.type)) {
      toast.error(t('sweep.settings.business.logo.invalidFileType'));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error(t('sweep.settings.business.logo.fileTooLarge'));
      return;
    }

    setUploading(true);
    try {
      const client = await getClient();

      // Step 1: Generate upload URL. app-api /api/storage/* — api-worker never
      // mounted a /storage router, so this three-step flow 404'd there. Both
      // storage endpoints answer un-enveloped (no `{ data }` wrapper), and the
      // returned uploadUrl is token-authenticated, so step 2 stays a bare fetch.
      const genRes = await client.post<{
        success: boolean;
        uploadUrl?: string;
        uploadToken?: string;
        fileKey?: string;
      }>('/storage/generate-upload-url', {
        fileName: file.name,
        contentType: file.type,
        fileSize: file.size,
        folder: 'branding',
        entityType: 'workspace-logo',
        isPublic: true,
      });

      if (!genRes?.uploadUrl || !genRes?.uploadToken || !genRes?.fileKey) {
        throw new Error(t('sweep.settings.business.logo.failedToGetUploadUrl'));
      }

      // Step 2: Upload to R2
      const uploadRes = await fetch(genRes.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!uploadRes.ok) throw new Error(t('sweep.settings.business.logo.failedToUploadFile'));

      const etag = uploadRes.headers.get('ETag');

      // Step 3: Confirm upload
      const confirmRes = await client.post<{
        success: boolean;
        file?: { url: string };
      }>('/storage/confirm-upload', {
        uploadToken: genRes.uploadToken,
        fileKey: genRes.fileKey,
        etag: etag || undefined,
      });

      const imageUrl = confirmRes?.file?.url;
      if (!imageUrl) throw new Error(t('sweep.settings.business.logo.failedToConfirmUpload'));

      onLogoUploaded(imageUrl);
      toast.success(t('sweep.settings.business.logo.uploadedSuccessfully'));
    } catch (err) {
      console.error('Logo upload error:', err);
      toast.error(err instanceof Error ? err.message : t('sweep.settings.business.logo.failedToUpload'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="flex items-center gap-4">
      <div className="relative">
        <Avatar className="h-20 w-20 rounded-[1.25rem]">
          {currentLogoUrl ? (
            <img src={currentLogoUrl} alt={t('sweep.settings.business.logo.alt')} className="object-cover" />
          ) : (
            <AvatarFallback className="text-2xl rounded-[1.25rem]">{initial}</AvatarFallback>
          )}
        </Avatar>
        {uploading && (
          <div className="absolute inset-0 rounded-[1.25rem] bg-background/60 flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
      <div className="flex-1">
        <p className="text-sm font-medium">{t('sweep.settings.business.logo.companyLogo')}</p>
        <p className="text-xs text-muted-foreground mb-2">{t('sweep.settings.business.logo.uploadHint')}</p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shadow-none"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <Upload className="h-4 w-4 mr-0.5" />
            {t('sweep.settings.business.logo.chooseFile')}
          </Button>
          {currentLogoUrl && (
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label={t('sweep.settings.business.logo.removeLogo')}
              className="h-8 w-8 rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600 hover:border-red-200 dark:hover:bg-red-950/30 dark:hover:text-red-400 dark:hover:border-red-900"
              onClick={onLogoRemoved}
              disabled={uploading}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".jpg,.jpeg,.png,.gif,.webp,.svg"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          disabled={uploading}
        />
      </div>
    </div>
  );
}

interface WorkspaceBusinessSettingsData {
  timezone?: string;
  legalName?: string;
  tradingName?: string;
  contactFirstName?: string;
  contactLastName?: string;
  email?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  vatNumber?: string;
  registrationNumber?: string;
  logoUrl?: string | null;
}

export function BusinessSettingsForm() {
  const { t } = useI18n();
  const st = useTranslations();
  const ts = t.settings.generalSettings;
  const { data: settingsData, isLoading } = useWorkspaceSettings();
  const { data: member } = useCurrentMember();
  const updateMutation = useUpdateWorkspaceSettings();
  const isSaving = updateMutation.isPending;
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [countryOpen, setCountryOpen] = useState(false);
  const [timezoneOpen, setTimezoneOpen] = useState(false);

  const form = useForm<BusinessSettingsValues>({
    resolver: zodResolver(getBusinessSettingsSchema(st)),
    defaultValues: {
      timezone: 'Europe/Amsterdam',
      legalName: '',
      tradingName: '',
      contactFirstName: '',
      contactLastName: '',
      email: '',
      phone: '',
      addressLine1: '',
      addressLine2: '',
      city: '',
      state: '',
      postalCode: '',
      countryCode: 'NL',
      taxId: '',
      registrationNumber: '',
    },
  });

  useEffect(() => {
    if (settingsData?.data) {
      const ws = settingsData.data as WorkspaceBusinessSettingsData;
      form.reset({
        timezone: ws.timezone || 'Europe/Amsterdam',
        legalName: ws.legalName || '',
        tradingName: ws.tradingName || '',
        contactFirstName: ws.contactFirstName || '',
        contactLastName: ws.contactLastName || '',
        email: ws.email || '',
        phone: ws.phone || '',
        addressLine1: ws.addressLine1 || '',
        addressLine2: ws.addressLine2 || '',
        city: ws.city || '',
        state: ws.state || '',
        postalCode: ws.postalCode || '',
        countryCode: ws.country || 'NL',
        taxId: ws.vatNumber || '',
        registrationNumber: ws.registrationNumber || '',
      });
      setLogoUrl(ws.logoUrl || null);
    }
  }, [settingsData, form]);

  const handleLogoUploaded = async (url: string) => {
    setLogoUrl(url);
    try {
      await updateMutation.mutateAsync({ logoUrl: url });
    } catch {
      // Toast already shown by upload component; settings save is best-effort here
    }
  };

  const handleLogoRemoved = async () => {
    setLogoUrl(null);
    try {
      await updateMutation.mutateAsync({ logoUrl: null });
      toast.success(t.settings.messages.settingsSaved);
    } catch {
      toast.error(t.settings.messages.failedToSave);
    }
  };

  const onSubmit = async (data: BusinessSettingsValues) => {
    try {
      await updateMutation.mutateAsync({
        timezone: data.timezone,
        legalName: data.legalName || null,
        tradingName: data.tradingName || null,
        contactFirstName: data.contactFirstName,
        contactLastName: data.contactLastName,
        email: data.email,
        phone: data.phone,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2 || null,
        city: data.city,
        state: data.state || null,
        postalCode: data.postalCode,
        country: data.countryCode,
        vatNumber: data.taxId || null,
        registrationNumber: data.registrationNumber || null,
      });
      form.reset(data);
      toast.success(t.settings.messages.settingsSaved);
      return true;
    } catch (error) {
      console.error('Error saving settings:', error);
      toast.error(error instanceof Error ? error.message : t.settings.messages.failedToSave);
      return false;
    }
  };

  const isDirty = form.formState.isDirty;
  const { proceed, reset, status } = useBlocker({
    shouldBlockFn: () => isDirty,
    withResolver: true,
    enableBeforeUnload: isDirty,
  });
  const blocked = status === 'blocked';

  const handleSaveAndProceed = async () => {
    const isValid = await form.trigger();
    if (!isValid) return;
    const data = form.getValues();
    const success = await onSubmit(data);
    if (success && proceed) {
      proceed();
    }
  };

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
          <p className="text-muted-foreground">{ts.description}</p>
        </div>

        {/* Workspace name */}
        <WorkspaceNameSection />

        <Separator />

        {/* Workspace identifier (slug) */}
        <WorkspaceSlugCard />

        <Separator />

        {/* Company Logo */}
        <LogoUpload
          currentLogoUrl={logoUrl}
          companyName={form.watch('tradingName') || form.watch('legalName') || ''}
          onLogoUploaded={handleLogoUploaded}
          onLogoRemoved={handleLogoRemoved}
        />

        <Separator />

        {/* Timezone */}
        <div>
          <h3 className="text-lg font-semibold mb-1">{ts.timezone.title}</h3>
          <p className="text-sm text-muted-foreground mb-4">
            {ts.timezone.description}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="timezone"
            render={({ field }) => {
              const selectedTz = TIMEZONES.find((tz) => tz.id === field.value);
              return (
                <FormItem className="flex flex-col">
                  <Popover open={timezoneOpen} onOpenChange={setTimezoneOpen}>
                    <PopoverTrigger asChild>
                      <FormControl>
                        <Button
                          type="button"
                          variant="outline"
                          role="combobox"
                          aria-expanded={timezoneOpen}
                          className={cn(
                            'w-full justify-between font-normal',
                            !selectedTz && 'text-muted-foreground'
                          )}
                        >
                          {selectedTz ? selectedTz.label : ts.timezone.placeholder}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </FormControl>
                    </PopoverTrigger>
                    <PopoverContent
                      className="w-[var(--radix-popover-trigger-width)] min-w-[var(--radix-popover-trigger-width)] p-0"
                      align="start"
                      onOpenAutoFocus={() => {
                        requestAnimationFrame(() => {
                          const list = document.querySelector<HTMLDivElement>(
                            '[data-business-timezone-list]'
                          );
                          if (!list) return;
                          const item = list.querySelector<HTMLElement>(
                            '[cmdk-item][data-selected="true"]'
                          );
                          if (!item) return;
                          const offset = item.offsetTop - list.clientHeight * 0.6 + item.clientHeight / 2;
                          list.scrollTop = Math.max(0, offset);
                        });
                      }}
                    >
                      <Command defaultValue={selectedTz?.label}>
                        <CommandInput placeholder={st('sweep.settings.business.searchTimezonePlaceholder')} />
                        <CommandList
                          data-business-timezone-list
                          className="max-h-[240px] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent"
                        >
                          <CommandEmpty>{st('sweep.settings.business.noTimezoneFound')}</CommandEmpty>
                          <CommandGroup className="pr-0">
                            {TIMEZONES.map((tz) => {
                              const isCurrent = field.value === tz.id;
                              return (
                                <CommandItem
                                  key={tz.id}
                                  value={tz.label}
                                  onSelect={() => {
                                    field.onChange(tz.id);
                                    setTimezoneOpen(false);
                                  }}
                                  className={cn(
                                    'flex justify-between',
                                    isCurrent && 'bg-accent text-accent-foreground'
                                  )}
                                >
                                  {tz.label}
                                  <Check
                                    className={cn(
                                      'h-4 w-4',
                                      field.value === tz.id ? 'opacity-100' : 'opacity-0'
                                    )}
                                  />
                                </CommandItem>
                              );
                            })}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <FormMessage />
                </FormItem>
              );
            }}
          />
          </div>
        </div>

        <Separator />

        {/* Company Details */}
        <div>
          <h3 className="text-lg font-semibold mb-4">{ts.companyDetails}</h3>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="legalName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.legalName}</FormLabel>
                    <FormControl>
                      <Input placeholder="Acme Corporation B.V." {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="tradingName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.tradingName}</FormLabel>
                    <FormControl>
                      <Input placeholder="Acme Corp" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="taxId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.vatTaxId}</FormLabel>
                    <FormControl>
                      <Input placeholder="NL123456789B01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="registrationNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.registrationNumber}</FormLabel>
                    <FormControl>
                      <Input placeholder="KVK 12345678" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </div>
        </div>

        <Separator />

        {/* Contact Person */}
        <div>
          <h3 className="text-lg font-semibold mb-4">{ts.contactPerson}</h3>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="contactFirstName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.firstName}</FormLabel>
                    <FormControl>
                      <Input placeholder="Jan" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="contactLastName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.lastName}</FormLabel>
                    <FormControl>
                      <Input placeholder="de Vries" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.email}</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="info@example.nl" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.phone}</FormLabel>
                    <FormControl>
                      <Input placeholder="+31 20 123 4567" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </div>
        </div>

        <Separator />

        {/* Address */}
        <div>
          <h3 className="text-lg font-semibold mb-4">{ts.address}</h3>
          <div className="space-y-4">
            <FormField
              control={form.control}
              name="addressLine1"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{ts.address}</FormLabel>
                  <FormControl>
                    <Input placeholder="Keizersgracht 100" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="addressLine2"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{ts.addressLine2}</FormLabel>
                  <FormControl>
                    <Input placeholder="2nd floor" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="postalCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.postalCode}</FormLabel>
                    <FormControl>
                      <Input placeholder="1015 AA" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.city}</FormLabel>
                    <FormControl>
                      <Input placeholder="Amsterdam" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="state"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.provinceState}</FormLabel>
                    <FormControl>
                      <Input placeholder="Noord-Holland" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="countryCode"
                render={({ field }) => {
                  const selected = COUNTRIES.find((c) => c.code === field.value);
                  return (
                    <FormItem className="flex flex-col">
                      <FormLabel>{ts.country}</FormLabel>
                      <Popover open={countryOpen} onOpenChange={setCountryOpen}>
                        <PopoverTrigger asChild>
                          <FormControl>
                            <Button
                              type="button"
                              variant="outline"
                              role="combobox"
                              aria-expanded={countryOpen}
                              className={cn(
                                'w-full justify-between font-normal',
                                !selected && 'text-muted-foreground'
                              )}
                            >
                              {selected ? selected.name : ts.selectCountry}
                              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                            </Button>
                          </FormControl>
                        </PopoverTrigger>
                        <PopoverContent
                          className="w-[var(--radix-popover-trigger-width)] min-w-[var(--radix-popover-trigger-width)] p-0"
                          align="start"
                          onOpenAutoFocus={() => {
                            requestAnimationFrame(() => {
                              const list = document.querySelector<HTMLDivElement>(
                                '[data-business-country-list]'
                              );
                              if (!list) return;
                              const item = list.querySelector<HTMLElement>(
                                '[cmdk-item][data-selected="true"]'
                              );
                              if (!item) return;
                              const offset = item.offsetTop - list.clientHeight * 0.6 + item.clientHeight / 2;
                              list.scrollTop = Math.max(0, offset);
                            });
                          }}
                        >
                          <Command defaultValue={selected?.name}>
                            <CommandInput placeholder={st('sweep.settings.business.searchCountryPlaceholder')} />
                            <CommandList
                              data-business-country-list
                              className="max-h-[240px] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent"
                            >
                              <CommandEmpty>{st('sweep.settings.business.noCountryFound')}</CommandEmpty>
                              <CommandGroup className="pr-0">
                                {COUNTRIES.map((country) => {
                                  const isCurrent = field.value === country.code;
                                  return (
                                  <CommandItem
                                    key={country.code}
                                    value={country.name}
                                    onSelect={() => {
                                      field.onChange(country.code);
                                      setCountryOpen(false);
                                    }}
                                    className={cn(
                                      'flex justify-between',
                                      isCurrent && 'bg-accent text-accent-foreground'
                                    )}
                                  >
                                    {country.name}
                                    <Check
                                      className={cn(
                                        'h-4 w-4',
                                        field.value === country.code ? 'opacity-100' : 'opacity-0'
                                      )}
                                    />
                                  </CommandItem>
                                  );
                                })}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />
            </div>
          </div>
        </div>

        {/* Save */}
        <div className="flex justify-end">
          <Button type="submit" disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                {t.settings.actions.saving}
              </>
            ) : (
              t.settings.actions.saveChanges
            )}
          </Button>
        </div>
      </form>

      {/* Danger zone — owner-only workspace deletion. */}
      {member?.role === 'OWNER' && (
        <>
          <Separator className="my-8" />
          <DeleteWorkspaceSection />
        </>
      )}

      <Dialog
        open={blocked}
        onOpenChange={(open) => {
          if (!open && reset) reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{st('sweep.settings.business.unsavedChanges.title')}</DialogTitle>
            <DialogDescription>
              {st('sweep.settings.business.unsavedChanges.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => proceed?.()}
              disabled={isSaving}
            >
              {st('sweep.settings.business.unsavedChanges.discard')}
            </Button>
            <Button
              type="button"
              onClick={handleSaveAndProceed}
              disabled={isSaving}
            >
              {isSaving ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  {t.settings.actions.saving}
                </>
              ) : (
                t.settings.actions.saveChanges
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Form>
  );
}
