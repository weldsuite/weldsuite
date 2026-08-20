import { useState } from 'react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  useCommercePortalSettings,
  useUpdateCommercePortalSettings,
} from '@/hooks/queries/use-commerce-queries';

export default function WeldCommercePortalSettingsPage() {
  const t = getTranslations('commerce').module.portal;
  const settings = useCommercePortalSettings();
  const update = useUpdateCommercePortalSettings();
  const data = settings.data;

  const [displayName, setDisplayName] = useState<string | null>(null);
  const [logo, setLogo] = useState<string | null>(null);
  const [primaryColor, setPrimaryColor] = useState<string | null>(null);
  const [accentColor, setAccentColor] = useState<string | null>(null);

  const name = displayName ?? data?.displayName ?? '';
  const logoUrl = logo ?? data?.logo ?? '';
  const primary = primaryColor ?? data?.primaryColor ?? '';
  const accent = accentColor ?? data?.accentColor ?? '';

  async function save(patch: Record<string, unknown>) {
    try {
      await update.mutateAsync(patch);
      toast.success(t.saved);
    } catch {
      toast.error(t.saveFailed);
    }
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t.enabled}</CardTitle>
          <CardDescription>{t.enabledHelp}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="portal-enabled">{t.enabled}</Label>
            <Switch
              id="portal-enabled"
              checked={Boolean(data?.isEnabled)}
              disabled={settings.isLoading || update.isPending}
              onCheckedChange={(checked) => save({ isEnabled: checked })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t.copyUrl}</Label>
            <div className="flex gap-2">
              <Input readOnly value={data?.portalUrl ?? t.noSlug} />
              <Button
                type="button"
                variant="outline"
                disabled={!data?.portalUrl}
                onClick={async () => {
                  if (!data?.portalUrl) return;
                  await navigator.clipboard.writeText(data.portalUrl);
                  toast.success(t.copied);
                }}
              >
                {t.copyUrl}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.displayName}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="portal-name">{t.displayName}</Label>
            <Input
              id="portal-name"
              value={name}
              placeholder={t.displayNamePlaceholder}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="portal-logo">{t.logo}</Label>
            <Input id="portal-logo" value={logoUrl} onChange={(e) => setLogo(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="portal-primary">{t.primaryColor}</Label>
              <Input id="portal-primary" value={primary} onChange={(e) => setPrimaryColor(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="portal-accent">{t.accentColor}</Label>
              <Input id="portal-accent" value={accent} onChange={(e) => setAccentColor(e.target.value)} />
            </div>
          </div>
          <Button
            type="button"
            disabled={update.isPending}
            onClick={() =>
              save({
                displayName: name || null,
                logo: logoUrl || null,
                primaryColor: primary || null,
                accentColor: accent || null,
              })
            }
          >
            {t.save}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
