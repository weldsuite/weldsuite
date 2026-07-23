import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Globe, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { IntegrationDetailLayout } from '@/components/settings';

export default function SalesforceSettingsPage() {
  const t = useTranslations();
  const [isWorking, setIsWorking] = React.useState(false);
  const connected = false;

  const handleConnect = () => {
    setIsWorking(true);
    toast.info(t('sweep.settings.salesforcePage.comingSoon'));
    setTimeout(() => setIsWorking(false), 800);
  };

  const salesforceIcon = (
    <img
      src="https://api.iconify.design/logos:salesforce.svg"
      alt="Salesforce"
      className="h-8 w-8"
    />
  );

  return (
    <IntegrationDetailLayout
      name="Salesforce"
      description={t('sweep.settings.salesforcePage.description')}
      category="CRM"
      icon={salesforceIcon}
      connected={connected}
      isWorking={isWorking}
      connectLabel={t('sweep.settings.integrationConnectionCard.connect')}
      onConnect={handleConnect}
      provider="Salesforce"
      resources={[
        { label: t('sweep.settings.integrationConnectionCard.website'), href: 'https://www.salesforce.com', icon: Globe },
        { label: t('sweep.settings.integrationConnectionCard.documentation'), href: 'https://developer.salesforce.com/docs', icon: FileText },
      ]}
      overview={t('sweep.settings.salesforcePage.overview')}
    />
  );
}
