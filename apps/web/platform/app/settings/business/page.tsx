
import { Link } from '@tanstack/react-router';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { useCan } from '@weldsuite/permissions/react';
import { useI18n } from '@/lib/i18n/provider';
import { BusinessSettingsForm } from '@/app/settings/general/business-settings-form';

export default function BusinessSettingsPage() {
  const { t } = useI18n();
  const canSeeLegalEntities = useCan('legal_entities:read');
  return (
    <>
      {canSeeLegalEntities && (
        <div className="px-6 pt-6">
          <InfoBanner variant="info">
            {t.settings.legalEntities.businessNote}{' '}
            <Link to="/settings/legal-entities" className="font-medium underline underline-offset-2">
              {t.settings.menu.legalEntities}
            </Link>
            .
          </InfoBanner>
        </div>
      )}
      <BusinessSettingsForm />
    </>
  );
}
