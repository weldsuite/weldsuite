import { useI18n } from '@/lib/i18n/provider';

export default function NotesPage() {
  const { t } = useI18n();
  return (
    <div className="h-screen flex flex-col">
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">{t.projects.notes.notImplemented}</p>
      </div>
    </div>
  );
}