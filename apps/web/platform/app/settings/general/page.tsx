
import { useI18n } from '@/lib/i18n/provider';
import { BusinessSettingsForm } from './business-settings-form';

export default function GeneralSettingsPage() {
  const { t } = useI18n();
  const ts = t.settings.generalSettings;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <p className="text-muted-foreground">
          {ts.description}
        </p>
      </div>

      <BusinessSettingsForm />
    </div>
  );
}
