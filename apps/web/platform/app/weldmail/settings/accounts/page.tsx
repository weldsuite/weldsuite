import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';

export default function WeldMailSettingsAccountsPage() {
  const { t } = useI18n();
  useBreadcrumbs([
    { label: t.mail.header.mail, href: '/weldmail' },
    { label: t.mail.header.settings, href: '/weldmail/settings' },
    { label: t.mail.header.accounts },
  ]);

  return (
    <div className="container max-w-4xl py-8">
      <h1 className="text-3xl font-bold">{t.mail.accounts.title}</h1>
    </div>
  );
}
