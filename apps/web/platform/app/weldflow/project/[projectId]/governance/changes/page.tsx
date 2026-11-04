import { useI18n } from '@/lib/i18n/provider';

// Placeholder from the WeldFlow shell: slice A replaces this page.
export default function ChangeRequestsPage() {
  const { t } = useI18n();
  return <p className="py-16 text-center text-sm text-muted-foreground">{t.flowApprovals.title}</p>;
}
