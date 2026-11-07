import { WorkspacesList } from './workspaces-list';
import type { WorkspacesPageData } from './data';

export function WorkspacesPage({ workspaces, search }: Readonly<WorkspacesPageData>) {
  return <WorkspacesList workspaces={workspaces} initialSearch={search} />;
}
