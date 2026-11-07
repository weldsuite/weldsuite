import { notFound } from 'next/navigation';
import { loadAccessRequestPage } from './data';
import { AccessRequestPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page(props: Readonly<{ params: Promise<{ id: string }> }>) {
  const data = await loadAccessRequestPage(await props.params);
  if (!data) notFound();
  return <AccessRequestPage {...data} />;
}
