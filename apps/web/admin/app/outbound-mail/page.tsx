import { loadOutboundMailPage, type OutboundMailSearchParams } from './data';
import { OutboundMailPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page(props: Readonly<{ searchParams?: Promise<OutboundMailSearchParams> }>) {
  const data = await loadOutboundMailPage((await props.searchParams) ?? {});
  return <OutboundMailPage {...data} />;
}
