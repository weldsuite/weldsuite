import { useParams } from '@tanstack/react-router';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { LiveDoc } from './live-doc';
import { LocalDoc } from './local-doc';

/** One document: co-edited through its room in a workspace, kept in the browser in the preview. */
export default function DocPage() {
  // Not strict: the same page serves /welddocs/$docId and its /preview mirror.
  const { docId = '' } = useParams({ strict: false });
  const preview = usePreviewMode();
  return preview ? <LocalDoc key={docId} docId={docId} /> : <LiveDoc key={docId} docId={docId} />;
}
