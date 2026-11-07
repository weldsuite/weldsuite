import { loadWarmupNetworkPage, type WarmupNetworkSearchParams } from './data';
import { WarmupNetworkPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page(props: Readonly<{ searchParams?: Promise<WarmupNetworkSearchParams> }>) {
  const data = await loadWarmupNetworkPage((await props.searchParams) ?? {});
  return <WarmupNetworkPage {...data} />;
}
