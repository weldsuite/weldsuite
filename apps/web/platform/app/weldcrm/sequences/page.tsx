
import { useSequences } from '@/hooks/queries/use-sequences-queries';
import { SequencesListClient } from './components/sequences-list-client';
import { PageLoader } from '@/components/page-loader';

export default function SequencesPage() {
  const { data, isLoading } = useSequences();

  // `!data` also covers the persisted-query-client restore window, where the
  // query is paused (isLoading === false) but data hasn't rehydrated yet.
  // Without it we'd mount the list with an empty array, and the client's
  // initial-state snapshot would stick on empty even after the cache restores.
  if (isLoading || !data) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <SequencesListClient
      initialSequences={data?.data || []}
      total={data?.pagination?.totalCount || 0}
    />
  );
}
