import { useParams } from '@/lib/router';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { useDeskAnnouncement } from '@/hooks/queries/use-desk-knowledge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnnouncementForm } from '../announcement-form';

export default function EditAnnouncementPage() {
  const { t } = useI18n();
  const params = useParams();
  const id = params.id as string;
  const query = useDeskAnnouncement(id);

  if (query.data) return <AnnouncementForm key={query.data.id} announcement={query.data} />;
  if (query.isError) {
    return (
      <div className="p-6">
        <ErrorState message={t.helpdesk.announcementsAdmin.notFound} />
      </div>
    );
  }
  return <PageLoader fullScreen={false} />;
}
