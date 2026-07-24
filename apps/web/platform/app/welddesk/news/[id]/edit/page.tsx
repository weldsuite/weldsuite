
import { useParams } from '@/lib/router';
import { NewsEditorClient } from './news-editor-client';

export default function NewsEditorPage() {
  const params = useParams();
  const id = params.id as string;

  return <NewsEditorClient newsId={id} />;
}
