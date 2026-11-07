import { notFound } from 'next/navigation';
import { loadShardPage } from './data';
import { ShardPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page(props: Readonly<{ params: Promise<{ id: string }> }>) {
  const data = await loadShardPage(await props.params);
  if (!data) notFound();
  return <ShardPage {...data} />;
}
