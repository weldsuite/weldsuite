
import { useParams } from '@/lib/router';
import { AnnouncementEditorClient } from './announcement-editor-client';

export default function AnnouncementEditorPage() {
  const params = useParams();
  const id = params.id as string;

  return <AnnouncementEditorClient announcementId={id} />;
}
