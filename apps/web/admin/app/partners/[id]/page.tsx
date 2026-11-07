import { notFound } from 'next/navigation';
import { loadPartnerDetailPage } from './data';
import { PartnerDetailPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page(
  props: Readonly<{ params: Promise<{ id: string }>; searchParams?: Promise<{ tab?: string }> }>,
) {
  const { id } = await props.params;
  const { tab } = (await props.searchParams) ?? {};
  const data = await loadPartnerDetailPage({ id, tab });
  if (!data) notFound();
  return <PartnerDetailPage {...data} />;
}
