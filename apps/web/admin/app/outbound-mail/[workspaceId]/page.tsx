import { notFound } from 'next/navigation';
import { loadOutboundWorkspacePage } from './data';
import { OutboundWorkspacePage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page(props: Readonly<{ params: Promise<{ workspaceId: string }> }>) {
  const data = await loadOutboundWorkspacePage(await props.params);
  if (!data) notFound();
  return <OutboundWorkspacePage {...data} />;
}
