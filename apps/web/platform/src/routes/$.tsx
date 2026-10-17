import { createFileRoute, Link } from '@tanstack/react-router';
import { useI18n } from '@/lib/i18n/provider';

export const Route = createFileRoute('/$')({
  component: NotFoundPage,
});

function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 w-full h-full min-h-full items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold">404</h1>
        <p className="mt-2 text-muted-foreground">{t.common.notFound.title}</p>
        <Link to="/" className="mt-4 inline-block text-primary underline">
          {t.common.notFound.goHome}
        </Link>
      </div>
    </div>
  );
}
