import { useI18n } from '@/lib/i18n/provider';

// Placeholder from the WeldFlow shell: slice G replaces this page.
export default function IntakePage() {
  const { t } = useI18n();
  return <p className="py-16 text-center text-sm text-muted-foreground">{t.flowPortfolio.title}</p>;
}
