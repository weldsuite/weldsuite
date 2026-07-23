import { useI18n } from '@/lib/i18n/provider';

export default function DmListPage() {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground">
      {t.weldchat.dm.selectConversation}
    </div>
  );
}
