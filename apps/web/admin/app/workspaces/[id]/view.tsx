import { WorkspaceDetail } from './workspace-detail';
import type { WorkspaceDetailPageData } from './data';

export function WorkspaceDetailPage(props: Readonly<WorkspaceDetailPageData>) {
  return <WorkspaceDetail {...props} />;
}
