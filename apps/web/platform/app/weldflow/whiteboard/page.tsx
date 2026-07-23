
import { WhiteboardView } from '@/components/weldflow/whiteboard/whiteboard-view';

export default function WhiteboardPage() {
  // Standalone whiteboard page - uses a global project ID for shared whiteboard
  return <WhiteboardView projectId="global-whiteboard" />;
}