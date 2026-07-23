
import { useI18n } from '@/lib/i18n/provider';

export default function AdvancedSettingsPage() {
  const { t } = useI18n();
  const ts = t.settings.advanced;

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <p className="text-muted-foreground">{ts.description}</p>
      </div>

      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <p>{ts.underDevelopment}</p>
      </div>
    </div>
  );
}
