
import { useParams } from '@/lib/router';
import { ChangelogEditorClient } from './changelog-editor-client';

export default function ChangelogEditorPage() {
  const params = useParams();
  const id = params.id as string;

  return <ChangelogEditorClient changelogId={id} />;
}
