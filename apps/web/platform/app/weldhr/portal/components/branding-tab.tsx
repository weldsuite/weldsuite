/** WeldHR workforce portal — branding, custom domain, and a sign-in preview. */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageLoader } from '@/components/page-loader';
import { useHrPortalSettings, useUpdateHrPortalSettings } from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { SettingsPage, SettingsSection, SettingRow } from '../../components/page-kit';
import { ColorField } from '../../settings/components/color-field';

interface FormState {
  displayName: string;
  logoUrl: string;
  faviconUrl: string;
  primaryColor: string;
  accentColor: string;
  welcomeMessage: string;
  supportEmail: string;
  hideWeldsuiteBranding: boolean;
  customDomain: string;
}

function toForm(data: {
  displayName: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  welcomeMessage: string | null;
  supportEmail: string | null;
  hideWeldsuiteBranding: boolean;
  customDomain: string | null;
}): FormState {
  return {
    displayName: data.displayName ?? '',
    logoUrl: data.logoUrl ?? '',
    faviconUrl: data.faviconUrl ?? '',
    primaryColor: data.primaryColor ?? '#0d9488',
    accentColor: data.accentColor ?? '#0f172a',
    welcomeMessage: data.welcomeMessage ?? '',
    supportEmail: data.supportEmail ?? '',
    hideWeldsuiteBranding: data.hideWeldsuiteBranding,
    customDomain: data.customDomain ?? '',
  };
}

export function PortalBrandingTab() {
  const t = useTranslations();
  const { data, isLoading, error } = useHrPortalSettings();
  const update = useUpdateHrPortalSettings();
  const [state, setState] = useState<FormState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (data && !state) setState(toForm(data));
  }, [data, state]);

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (error) return <ErrorBanner error={errorMessage(error, t('weldhr.common.loadFailed'))} />;
  if (!data || !state) return null;

  const initial = toForm(data);
  const hasChanges = (Object.keys(state) as Array<keyof FormState>).some((key) => state[key] !== initial[key]);

  async function submit() {
    if (!state) return;
    setFailure(null);
    try {
      await update.mutateAsync({
        displayName: state.displayName.trim() || null,
        logoUrl: state.logoUrl.trim() || null,
        faviconUrl: state.faviconUrl.trim() || null,
        primaryColor: state.primaryColor.trim() || null,
        accentColor: state.accentColor.trim() || null,
        welcomeMessage: state.welcomeMessage.trim() || null,
        supportEmail: state.supportEmail.trim() || null,
        hideWeldsuiteBranding: state.hideWeldsuiteBranding,
        customDomain: state.customDomain.trim() || null,
      });
      toast.success(t('weldhr.portal.branding.saved'));
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.common.saveFailed')));
    }
  }

  function cancel() {
    if (data) setState(toForm(data));
  }

  return (
    <SettingsPage
      title={t('weldhr.portal.branding.identityTitle')}
      hasChanges={hasChanges}
      saving={update.isPending}
      onSave={() => void submit()}
      onCancel={cancel}
    >
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      <SettingsSection title={t('weldhr.portal.branding.identityTitle')}>
        <div className="space-y-1.5">
          <Label htmlFor="portal-display-name">{t('weldhr.portal.branding.displayName')}</Label>
          <Input
            id="portal-display-name"
            value={state.displayName}
            placeholder={t('weldhr.portal.branding.displayNamePlaceholder')}
            onChange={(e) => setState({ ...state, displayName: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="portal-logo">{t('weldhr.portal.branding.logoUrl')}</Label>
          <Input id="portal-logo" value={state.logoUrl} onChange={(e) => setState({ ...state, logoUrl: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="portal-favicon">{t('weldhr.portal.branding.faviconUrl')}</Label>
          <Input id="portal-favicon" value={state.faviconUrl} onChange={(e) => setState({ ...state, faviconUrl: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <ColorField
            id="portal-primary-color"
            label={t('weldhr.portal.branding.primaryColor')}
            value={state.primaryColor}
            onChange={(color) => setState({ ...state, primaryColor: color })}
          />
          <ColorField
            id="portal-accent-color"
            label={t('weldhr.portal.branding.accentColor')}
            value={state.accentColor}
            onChange={(color) => setState({ ...state, accentColor: color })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="portal-welcome">{t('weldhr.portal.branding.welcomeMessage')}</Label>
          <Textarea
            id="portal-welcome"
            value={state.welcomeMessage}
            onChange={(e) => setState({ ...state, welcomeMessage: e.target.value })}
            rows={3}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="portal-support-email">{t('weldhr.portal.branding.supportEmail')}</Label>
          <Input
            id="portal-support-email"
            type="email"
            value={state.supportEmail}
            onChange={(e) => setState({ ...state, supportEmail: e.target.value })}
          />
        </div>
        <SettingRow label={t('weldhr.portal.branding.hideWeldsuiteBranding')} description={t('weldhr.portal.branding.hideWeldsuiteBrandingHint')}>
          <Switch
            checked={state.hideWeldsuiteBranding}
            onCheckedChange={(checked) => setState({ ...state, hideWeldsuiteBranding: checked })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('weldhr.portal.branding.customDomainTitle')}>
        <div className="space-y-1.5">
          <Label htmlFor="portal-custom-domain">{t('weldhr.portal.branding.customDomain')}</Label>
          <Input
            id="portal-custom-domain"
            value={state.customDomain}
            placeholder="portal.yourcompany.com"
            onChange={(e) => setState({ ...state, customDomain: e.target.value })}
          />
        </div>
        <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
          {t('weldhr.portal.branding.customDomainDnsInstructions')}
        </p>
      </SettingsSection>

      <SettingsSection title={t('weldhr.portal.branding.previewTitle')}>
        <SignInPreview
          displayName={state.displayName || t('weldhr.portal.branding.previewDefaultName')}
          logoUrl={state.logoUrl}
          primaryColor={state.primaryColor || '#0d9488'}
          accentColor={state.accentColor || '#0f172a'}
          welcomeMessage={state.welcomeMessage}
          hideWeldsuiteBranding={state.hideWeldsuiteBranding}
        />
      </SettingsSection>
    </SettingsPage>
  );
}

function SignInPreview({
  displayName,
  logoUrl,
  primaryColor,
  accentColor,
  welcomeMessage,
  hideWeldsuiteBranding,
}: {
  displayName: string;
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
  welcomeMessage: string;
  hideWeldsuiteBranding: boolean;
}) {
  const t = useTranslations();
  return (
    <div className="max-w-sm overflow-hidden rounded-xl border shadow-sm" style={{ backgroundColor: accentColor }}>
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        {logoUrl ? (
          <img src={logoUrl} alt={displayName} className="h-10 max-w-full object-contain" />
        ) : (
          <div
            className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-semibold text-white"
            style={{ backgroundColor: primaryColor }}
          >
            {displayName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <p className="text-sm font-semibold text-white">{displayName}</p>
        {welcomeMessage && <p className="text-xs text-white/80">{welcomeMessage}</p>}
      </div>
      <div className="space-y-3 bg-background p-6">
        <div>
          <Label className="text-xs">{t('weldhr.portal.branding.previewEmailLabel')}</Label>
          <div className="mt-1 h-9 rounded-md border bg-muted" />
        </div>
        <Button className="w-full" style={{ backgroundColor: primaryColor, borderColor: primaryColor }} type="button" disabled>
          {t('weldhr.portal.branding.previewSignInButton')}
        </Button>
        {!hideWeldsuiteBranding && (
          <p className="pt-1 text-center text-[11px] text-muted-foreground">{t('weldhr.portal.branding.previewPoweredBy')}</p>
        )}
      </div>
    </div>
  );
}
