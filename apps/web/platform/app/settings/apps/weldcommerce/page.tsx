import { getTranslations } from '@/lib/i18n';
import { CustomerPortalSection } from './portal-section';

export default function WeldCommerceSettingsPage() {
  const ts = getTranslations('settings');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.weldcommerce.title}</h1>
        <p className="text-muted-foreground">{ts.weldcommerce.description}</p>
      </div>
      <CustomerPortalSection />
    </div>
  );
}
