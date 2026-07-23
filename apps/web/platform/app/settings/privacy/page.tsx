
import { Download, Trash } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Switch } from '@weldsuite/ui/components/switch';
import { Separator } from '@weldsuite/ui/components/separator';
import { useI18n } from '@/lib/i18n/provider';

export default function PrivacySettingsPage() {
  const { t } = useI18n();
  const ts = t.settings.privacy;

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <p className="text-muted-foreground">{ts.description}</p>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">{ts.dataPrivacy}</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{ts.analytics}</p>
              <p className="text-sm text-muted-foreground">{ts.analyticsDescription}</p>
            </div>
            <Switch defaultChecked />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{ts.personalizedAds}</p>
              <p className="text-sm text-muted-foreground">{ts.personalizedAdsDescription}</p>
            </div>
            <Switch />
          </div>
        </div>
      </div>

      <Separator />

      <div>
        <h3 className="text-lg font-semibold mb-4">{ts.dataManagement}</h3>
        <div className="flex items-center gap-2">
          <Button variant="outline">
            <Download className="h-4 w-4 mr-0.5" />
            {ts.downloadData}
          </Button>
          <Button variant="outline" className="text-destructive">
            <Trash className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
            {ts.deleteAccount}
          </Button>
        </div>
      </div>
    </div>
  );
}
