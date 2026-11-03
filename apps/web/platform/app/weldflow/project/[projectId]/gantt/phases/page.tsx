import { useI18n } from '@/lib/i18n/provider';

// Placeholder from the WeldFlow shell: slice C replaces this page.
export default function PhasesAndGatesPage() {
  const { t } = useI18n();
  return <p className="py-16 text-center text-sm text-muted-foreground">{t.flowSchedule.title}</p>;
}
