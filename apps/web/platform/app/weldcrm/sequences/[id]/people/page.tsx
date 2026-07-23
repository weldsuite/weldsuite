
import { useParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { useSequence, useSequenceEnrollments } from '@/hooks/queries/use-sequences-queries';
import { SequencePeopleClient } from './people-client';
import { getTranslations } from '@/lib/i18n';

export default function SequencePeoplePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const t = getTranslations('crm');

  const { data: sequenceData, isLoading: seqLoading } = useSequence(id);
  const { data: enrollmentsData, isLoading: enrollLoading } = useSequenceEnrollments(id);

  if (seqLoading || enrollLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const sequence = sequenceData?.data;

  if (!sequence) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">{t.sequencePeoplePage.notFound}</p>
      </div>
    );
  }

  return (
    <SequencePeopleClient
      sequence={sequence}
      initialEnrollments={enrollmentsData?.data || []}
      initialPagination={enrollmentsData?.pagination}
    />
  );
}
