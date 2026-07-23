import { useI18n } from '@/lib/i18n/provider';

export default function AddRecurringInvoicePage() {
  const { t } = useI18n();
  const trp = t.accounting.recurringPage;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">{trp.addTitle}</h1>
      <p className="text-muted-foreground mt-2">{trp.comingSoon}</p>
    </div>
  );
}
