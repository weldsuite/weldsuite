import { useParams } from '@tanstack/react-router';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { LiveBoard } from './live-board';
import { LocalBoard } from './local-board';
import { useBoardExtensions } from './extensions';

/** One board: co-edited through its room in a workspace, kept in the browser in the preview. */
export default function BoardPage() {
  // Not strict: the same page serves /weldboard/$boardId and its /preview mirror.
  const { boardId = '' } = useParams({ strict: false });
  const preview = usePreviewMode();
  const extend = useBoardExtensions();
  return preview ? <LocalBoard key={boardId} boardId={boardId} /> : <LiveBoard key={boardId} boardId={boardId} extend={extend} />;
}
