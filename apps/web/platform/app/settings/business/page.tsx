import { Link } from '@tanstack/react-router';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { useCan } from '@weldsuite/permissions/react';
import { useI18n } from '@/lib/i18n/provider';
import { BusinessSettingsForm } from '@/app/settings/general/business-settings-form';

export default function BusinessSettingsPage() {
  const { t } = useI18n();
  const canSeeLegalEntities = useCan('legal_entities:read');
  // The note sits under the page header, in the page's own inset (TASK-1425).
  const notice = canSeeLegalEntities ? (
    <InfoBanner variant="info">
      {t.settings.legalEntities.businessNote}{' '}
      <Link to="/settings/legal-entities" className="font-medium underline underline-offset-2">
        {t.settings.menu.legalEntities}
      </Link>
      .
    </InfoBanner>
  ) : undefined;
  return <BusinessSettingsForm notice={notice} />;
}
