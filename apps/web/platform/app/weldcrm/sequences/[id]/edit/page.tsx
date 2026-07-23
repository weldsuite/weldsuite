import { useEffect } from 'react';
import { useParams, useRouter } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';

export default function SequenceEditPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    if (id) router.replace(`/weldcrm/sequences/${id}`);
  }, [id, router]);

  return <PageLoader fullScreen={false} />;
}
