import { notFound } from 'next/navigation';
import { loadEditAppPage } from './data';
import { EditAppPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page(props: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const data = await loadEditAppPage(await props.params);
  if (!data) notFound();
  return <EditAppPage {...data} />;
}
