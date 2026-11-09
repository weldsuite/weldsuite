import { toast } from 'sonner';
import { Laptop, Loader2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import {
  useCustomObjectTemplates,
  useInstallCustomObjectTemplate,
} from '@/hooks/queries/use-custom-objects-queries';

/**
 * Settings → Apps → WeldDesk: the asset register. "Set up" installs the asset
 * object template (custom objects), which the inbox's details panel then
 * attaches to conversations; once installed the card opens the asset list.
 */
export function AssetRegisterCard() {
  const t = getTranslations('helpdesk').assets;
  const router = useRouter();
  const { can } = usePermissions();
  const canManage = can('weldobjects:manage');
  const canSee = canManage || can('weldobjects:read');
  const { data: templates, isLoading } = useCustomObjectTemplates(canSee);
  const install = useInstallCustomObjectTemplate();
  const asset = templates?.find((template) => template.key === 'asset');

  if (!canSee) return null;

  const setUp = async () => {
    try {
      await install.mutateAsync('asset');
      toast.success(t.installed);
    } catch {
      toast.error(t.installFailed);
    }
  };

  let action: React.ReactNode = null;
  if (isLoading) {
    action = <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  } else if (asset?.installed) {
    action = (
      <Button variant="outline" size="sm" onClick={() => router.push(`/objects/${asset.slug}`)}>
        {t.open}
      </Button>
    );
  } else if (canManage) {
    action = (
      <Button size="sm" onClick={() => void setUp()} disabled={install.isPending} data-testid="desk-asset-register-setup">
        {install.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
        {install.isPending ? t.settingUp : t.setUp}
      </Button>
    );
  }

  return (
    <section aria-labelledby="welddesk-settings-assets" className="space-y-2" data-testid="desk-asset-register">
      <h2 id="welddesk-settings-assets" className="text-sm font-medium text-muted-foreground">
        {t.settingsTitle}
      </h2>
      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Laptop className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{t.settingsTitle}</span>
          <span className="block text-sm text-muted-foreground">{t.settingsDescription}</span>
          {!asset?.installed && !canManage && !isLoading && (
            <span className="mt-1 block text-xs text-muted-foreground">{t.askAdmin}</span>
          )}
        </span>
        {action}
      </div>
    </section>
  );
}
