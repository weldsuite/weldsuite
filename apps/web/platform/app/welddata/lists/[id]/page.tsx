import { useParams } from '@/lib/router';
import { useWelddataList } from '@/hooks/queries/use-welddata-queries';
import { WelddataLeadsGrid } from '../../components/welddata-leads-grid';

export default function WelddataListDetailPage() {
  const { id } = useParams() as { id: string };
  const { data: list } = useWelddataList(id);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0">
        <WelddataLeadsGrid listId={id} listName={list?.name} listKind={list?.kind} />
      </div>
    </div>
  );
}
