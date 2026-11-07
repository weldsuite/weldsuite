import { notFound } from 'next/navigation';
import { loadPlanDetailPage } from './data';
import { PlanDetailPage } from './view';

export const dynamic = 'force-dynamic';

export default async function Page(props: Readonly<{ params: Promise<{ id: string }> }>) {
  const data = await loadPlanDetailPage(await props.params);
  if (!data) notFound();
  return <PlanDetailPage {...data} />;
}
