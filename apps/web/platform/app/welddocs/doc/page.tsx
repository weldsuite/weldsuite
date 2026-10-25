import { useParams } from '@tanstack/react-router';
import { LocalDoc } from './local-doc';

/** One document. Kept in the browser until live co-editing (docs-api) arrives. */
export default function DocPage() {
  // Not strict: the same page serves /welddocs/$docId and its /preview mirror.
  const { docId = '' } = useParams({ strict: false });
  return <LocalDoc key={docId} docId={docId} />;
}
