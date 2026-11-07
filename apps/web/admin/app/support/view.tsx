import { SupportInbox } from './support-inbox';
import type { SupportPageData } from './data';

export function SupportPage({ workspaces }: Readonly<SupportPageData>) {
  return <SupportInbox workspaces={workspaces} />;
}
