'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Loader2, Trash2, CheckCircle, AlertCircle, ExternalLink, Copy } from 'lucide-react';
import { toast } from 'sonner';
import {
  useUpdateHelpcenterSettings,
  useEnableHelpcenter,
  useHelpcenterDomains,
  useHelpcenterHostDomains,
  useAddHelpcenterDomain,
  useVerifyHelpcenterDomain,
  useDeleteHelpcenterDomain,
} from '@/hooks/queries/use-helpdesk-queries';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface HelpcenterSettingsData {
  id?: string;
  isEnabled?: number;
  siteName?: string | null;
  logo?: string | null;
  logoDark?: string | null;
  favicon?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
  heroTitle?: string | null;
  heroSubtitle?: string | null;
  showSearch?: number;
  showCategories?: number;
  metaTitle?: string | null;
  metaDescription?: string | null;
  ogImage?: string | null;
  footerText?: string | null;
  socialLinks?: Record<string, string> | null;
  customCss?: string | null;
  googleAnalyticsId?: string | null;
  defaultSubdomain?: string | null;
  customDomain?: string | null;
}

interface Props {
  initialSettings: HelpcenterSettingsData | null;
}

/** Minimal, card-less settings section: heading + divider, matching the other app settings tabs. */
function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-4 border-t pt-6 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function HelpcenterSettingsClient({ initialSettings }: Props) {
  const { t } = useI18n();
  const st = useTranslations();
  const th = t.helpdesk.helpcenterSettings;
  const [settings, setSettings] = useState<HelpcenterSettingsData>(initialSettings || {});
  const [hasChanges, setHasChanges] = useState(false);
  const [selectedHostDomainId, setSelectedHostDomainId] = useState('');
  const [subdomain, setSubdomain] = useState('help');

  // The platform persists the query cache and serves it stale-while-revalidate,
  // so `initialSettings` arrives stale on first paint and is replaced once the
  // background refetch settles. Adopt the fresh server value when it changes —
  // unless the user has unsaved edits in the form — so a saved/enabled state
  // isn't frozen to the stale cached value.
  useEffect(() => {
    if (initialSettings && !hasChanges) {
      setSettings(initialSettings);
    }
  }, [initialSettings, hasChanges]);

  const updateMutation = useUpdateHelpcenterSettings();
  const enableMutation = useEnableHelpcenter();
  const { data: domains, isLoading: domainsLoading } = useHelpcenterDomains();
  const { data: hostDomains } = useHelpcenterHostDomains();
  const addDomainMutation = useAddHelpcenterDomain();
  const verifyDomainMutation = useVerifyHelpcenterDomain();
  const deleteDomainMutation = useDeleteHelpcenterDomain();

  const isEnabled = settings.isEnabled === 1;

  const updateField = (field: string, value: any) => {
    setSettings((prev) => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const handleEnable = async () => {
    try {
      const result = await enableMutation.mutateAsync({});
      setSettings((prev) => ({
        ...prev,
        isEnabled: 1,
        defaultSubdomain: result.data?.domain,
      }));
      toast.success(th.helpCenterEnabled);
    } catch {
      toast.error(th.failedToEnableHelpCenter);
    }
  };

  const handleSave = async () => {
    try {
      await updateMutation.mutateAsync({
        siteName: settings.siteName,
        logo: settings.logo,
        logoDark: settings.logoDark,
        favicon: settings.favicon,
        primaryColor: settings.primaryColor,
        accentColor: settings.accentColor,
        heroTitle: settings.heroTitle,
        heroSubtitle: settings.heroSubtitle,
        showSearch: settings.showSearch,
        showCategories: settings.showCategories,
        metaTitle: settings.metaTitle,
        metaDescription: settings.metaDescription,
        ogImage: settings.ogImage,
        footerText: settings.footerText,
        socialLinks: settings.socialLinks,
        customCss: settings.customCss,
        googleAnalyticsId: settings.googleAnalyticsId,
      });
      setHasChanges(false);
      toast.success(th.settingsSaved);
    } catch {
      toast.error(th.failedToSaveSettings);
    }
  };

  const handleAttachHostDomain = async () => {
    if (!selectedHostDomainId) return;
    try {
      await addDomainMutation.mutateAsync({
        hostDomainId: selectedHostDomainId,
        subdomain: subdomain.trim() || 'help',
      });
      setSelectedHostDomainId('');
      setSubdomain('help');
      toast.success(th.domainAttached);
    } catch {
      toast.error(th.failedToAddDomain);
    }
  };

  const handleVerifyDomain = async (id: string) => {
    try {
      await verifyDomainMutation.mutateAsync(id);
      toast.success(th.domainVerified);
    } catch {
      toast.error(th.domainVerificationFailed);
    }
  };

  const handleDeleteDomain = async (id: string) => {
    try {
      await deleteDomainMutation.mutateAsync(id);
      toast.success(th.domainRemoved);
    } catch {
      toast.error(th.failedToRemoveDomain);
    }
  };

  // Setup / enable screen
  if (!isEnabled) {
    return (
      <div className="max-w-3xl space-y-4">
        <div>
          <h3 className="text-sm font-medium">{th.enableTitle}</h3>
          <p className="text-sm text-muted-foreground">{th.enableDesc}</p>
        </div>
        <Button onClick={handleEnable} disabled={enableMutation.isPending}>
          {enableMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {th.enableButton}
        </Button>
      </div>
    );
  }

  // Settings UI (enabled)
  return (
    <div className="max-w-3xl space-y-8">
      {/* Action row */}
      <div className="flex items-center justify-end gap-3">
        {settings.defaultSubdomain && (
          <a
            href={`https://${settings.defaultSubdomain}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {th.visitLink}
          </a>
        )}
        <Button onClick={handleSave} disabled={!hasChanges || updateMutation.isPending}>
          {updateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {th.saveChanges}
        </Button>
      </div>

      {/* General */}
      <Section title={th.sectionGeneral}>
        <div className="space-y-2">
          <Label>{th.siteName}</Label>
          <Input
            value={settings.siteName || ''}
            onChange={(e) => updateField('siteName', e.target.value)}
            placeholder={st('sweep.welddesk.helpcenterSettings.siteNamePlaceholder')}
          />
        </div>
        <div className="space-y-2">
          <Label>{th.heroTitle}</Label>
          <Input
            value={settings.heroTitle || ''}
            onChange={(e) => updateField('heroTitle', e.target.value)}
            placeholder={st('sweep.welddesk.helpcenterSettings.heroTitlePlaceholder')}
          />
        </div>
        <div className="space-y-2">
          <Label>{th.heroSubtitle}</Label>
          <Input
            value={settings.heroSubtitle || ''}
            onChange={(e) => updateField('heroSubtitle', e.target.value)}
            placeholder={st('sweep.welddesk.helpcenterSettings.heroSubtitlePlaceholder')}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label>{th.showSearchBar}</Label>
          <Switch
            checked={settings.showSearch === 1}
            onCheckedChange={(checked) => updateField('showSearch', checked ? 1 : 0)}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label>{th.showCategories}</Label>
          <Switch
            checked={settings.showCategories === 1}
            onCheckedChange={(checked) => updateField('showCategories', checked ? 1 : 0)}
          />
        </div>
      </Section>

      {/* Branding */}
      <Section title={th.sectionBranding}>
        <div className="space-y-2">
          <Label>{th.logoUrl}</Label>
          <Input
            value={settings.logo || ''}
            onChange={(e) => updateField('logo', e.target.value)}
            placeholder="https://..."
          />
        </div>
        <div className="space-y-2">
          <Label>{th.logoDarkUrl}</Label>
          <Input
            value={settings.logoDark || ''}
            onChange={(e) => updateField('logoDark', e.target.value)}
            placeholder="https://..."
          />
        </div>
        <div className="space-y-2">
          <Label>{th.faviconUrl}</Label>
          <Input
            value={settings.favicon || ''}
            onChange={(e) => updateField('favicon', e.target.value)}
            placeholder="https://..."
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>{th.primaryColor}</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={settings.primaryColor || '#0070f3'}
                onChange={(e) => updateField('primaryColor', e.target.value)}
                className="h-9 w-9 rounded border cursor-pointer"
              />
              <Input
                value={settings.primaryColor || ''}
                onChange={(e) => updateField('primaryColor', e.target.value)}
                placeholder="#0070f3"
                className="flex-1"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>{th.accentColor}</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={settings.accentColor || '#7c3aed'}
                onChange={(e) => updateField('accentColor', e.target.value)}
                className="h-9 w-9 rounded border cursor-pointer"
              />
              <Input
                value={settings.accentColor || ''}
                onChange={(e) => updateField('accentColor', e.target.value)}
                placeholder="#7c3aed"
                className="flex-1"
              />
            </div>
          </div>
        </div>
      </Section>

      {/* Domains */}
      <Section title={th.sectionDomains} description={th.domainsDesc}>
        {/* Default subdomain */}
        {settings.defaultSubdomain && (
          <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/50">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              <span className="font-mono text-sm">{settings.defaultSubdomain}</span>
              <span className="text-xs text-muted-foreground">{th.defaultLabel}</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(`https://${settings.defaultSubdomain}`);
                toast.success(th.copiedToClipboard);
              }}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {/* Custom domains */}
        {!domainsLoading && domains?.map((domain: any) => (
          <div key={domain.id} className="flex items-center justify-between p-3 rounded-lg border">
            <div className="flex items-center gap-2">
              {domain.isVerified ? (
                <CheckCircle className="h-4 w-4 text-green-500" />
              ) : (
                <AlertCircle className="h-4 w-4 text-yellow-500" />
              )}
              <span className="font-mono text-sm">{domain.domain}</span>
              {!domain.isVerified && (
                <span className="text-xs text-yellow-600">{th.pendingVerification}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!domain.isVerified && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleVerifyDomain(domain.id)}
                  disabled={verifyDomainMutation.isPending}
                >
                  {th.verifyButton}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDeleteDomain(domain.id)}
                disabled={deleteDomainMutation.isPending}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
          </div>
        ))}

        {/* DNS instructions for unverified domains */}
        {domains?.some((d: any) => !d.isVerified) && (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/20 p-4 text-sm space-y-2">
            <p className="font-medium">{th.dnsRequired}</p>
            <p className="text-muted-foreground">
              {th.dnsRequiredDesc} <code className="bg-muted px-1 py-0.5 rounded">cname.vercel-dns.com</code>
            </p>
          </div>
        )}

        {/* WeldHost one-click attach */}
        <div className="rounded-lg border p-4 space-y-3">
          <div>
            <p className="font-medium text-sm">{th.attachFromWeldHost}</p>
            <p className="text-xs text-muted-foreground">{th.attachFromWeldHostDesc}</p>
          </div>
          {hostDomains && hostDomains.length > 0 ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[200px] space-y-1">
                <Label className="text-xs">{th.sectionDomains}</Label>
                <Select value={selectedHostDomainId} onValueChange={setSelectedHostDomainId}>
                  <SelectTrigger>
                    <SelectValue placeholder={th.selectDomainPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {hostDomains.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.fullDomain}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-32 space-y-1">
                <Label className="text-xs">{th.subdomainLabel}</Label>
                <Input value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder={st('sweep.welddesk.helpcenterSettings.subdomainPlaceholder')} />
              </div>
              <Button onClick={handleAttachHostDomain} disabled={addDomainMutation.isPending || !selectedHostDomainId}>
                {addDomainMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {th.attachButton}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{th.noWeldHostDomains}</p>
          )}
          {selectedHostDomainId && (
            <p className="text-xs text-muted-foreground">
              {(() => {
                const d = hostDomains?.find((h) => h.id === selectedHostDomainId);
                return d ? `${(subdomain.trim() || 'help')}.${d.fullDomain}` : null;
              })()}
            </p>
          )}
        </div>
      </Section>

      {/* SEO */}
      <Section title={th.sectionSeo}>
        <div className="space-y-2">
          <Label>{th.metaTitle}</Label>
          <Input
            value={settings.metaTitle || ''}
            onChange={(e) => updateField('metaTitle', e.target.value)}
            placeholder={st('sweep.welddesk.helpcenterSettings.metaTitlePlaceholder')}
          />
        </div>
        <div className="space-y-2">
          <Label>{th.metaDescription}</Label>
          <Textarea
            value={settings.metaDescription || ''}
            onChange={(e) => updateField('metaDescription', e.target.value)}
            placeholder={st('sweep.welddesk.helpcenterSettings.metaDescriptionPlaceholder')}
            rows={3}
          />
        </div>
        <div className="space-y-2">
          <Label>{th.ogImageUrl}</Label>
          <Input
            value={settings.ogImage || ''}
            onChange={(e) => updateField('ogImage', e.target.value)}
            placeholder="https://..."
          />
        </div>
      </Section>

      {/* Advanced */}
      <Section title={th.sectionAdvanced}>
        <div className="space-y-2">
          <Label>{th.customCss}</Label>
          <Textarea
            value={settings.customCss || ''}
            onChange={(e) => updateField('customCss', e.target.value)}
            placeholder=".hero { background: linear-gradient(...); }"
            rows={5}
            className="font-mono text-sm"
          />
        </div>
        <div className="space-y-2">
          <Label>{th.googleAnalyticsId}</Label>
          <Input
            value={settings.googleAnalyticsId || ''}
            onChange={(e) => updateField('googleAnalyticsId', e.target.value)}
            placeholder="G-XXXXXXXXXX"
          />
        </div>
        <div className="space-y-2">
          <Label>{th.footerText}</Label>
          <Textarea
            value={settings.footerText || ''}
            onChange={(e) => updateField('footerText', e.target.value)}
            placeholder={st('sweep.welddesk.helpcenterSettings.footerTextPlaceholder')}
            rows={2}
          />
        </div>
      </Section>
    </div>
  );
}
