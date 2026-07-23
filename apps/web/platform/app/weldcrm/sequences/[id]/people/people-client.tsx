
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { SequenceWizardNav } from '../components/sequence-wizard-nav';
import { PeopleTab } from '../components/people-tab';
import type { SequenceDetail, SequenceEnrollment, PaginationMeta } from '@/lib/api/domains/weldcrm';
import { getTranslations } from '@/lib/i18n';

interface SequencePeopleClientProps {
  sequence: SequenceDetail;
  initialEnrollments: SequenceEnrollment[];
  initialPagination?: PaginationMeta;
}

export function SequencePeopleClient({
  sequence,
  initialEnrollments,
  initialPagination,
}: SequencePeopleClientProps) {
  const t = getTranslations('crm');
  useBreadcrumbs([
    { label: t.sequences.breadcrumbCRM, href: '/weldcrm' },
    { label: t.sequences.breadcrumbSequences, href: '/weldcrm/sequences' },
    { label: sequence.name },
  ]);

  const isDraft = sequence.status === 'draft';
  const stepCount = Array.isArray(sequence.steps) ? sequence.steps.length : 0;
  const pendingCount = sequence.pendingEnrolledCount || 0;
  const enrolledCount = sequence.enrolledCount || 0;

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      <SequenceWizardNav
        sequenceId={sequence.id}
        sequenceName={sequence.name}
        currentStep={2}
        isDraft={isDraft}
      />

      {/* People Table */}
      <div className="flex-1 overflow-hidden">
        <PeopleTab
          sequenceId={sequence.id}
          sequenceStatus={sequence.status}
          initialEnrollments={initialEnrollments}
          initialPagination={initialPagination}
        />
      </div>
    </div>
  );
}
