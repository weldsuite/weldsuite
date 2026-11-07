import { notFound } from 'next/navigation';
import { loadWorkspaceDetailPage } from './data';
import { WorkspaceDetailPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page(props: Readonly<{ params: Promise<{ id: string }> }>) {
  const data = await loadWorkspaceDetailPage(await props.params);
  if (!data) notFound();
  return <WorkspaceDetailPage {...data} />;
}
