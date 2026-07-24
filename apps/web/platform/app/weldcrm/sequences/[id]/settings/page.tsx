
import { useParams } from '@/lib/router';
import { WorkflowSettingsContent } from '@/app/weldconnect/workflows/[id]/settings/page';
import { useSequence } from '@/hooks/queries/use-sequences-queries';
import { SequenceWizardNav } from '../components/sequence-wizard-nav';
import { PageLoader } from '@/components/page-loader';

export default function SequenceSettingsPage() {
  const params = useParams();
  const workflowId = params.id as string;
  const { data: sequenceResp, isLoading } = useSequence(workflowId);

  if (isLoading || !sequenceResp?.data) {
    return <PageLoader />;
  }

  const sequence = sequenceResp.data;
  const isDraft = sequence.status === 'draft';

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <SequenceWizardNav
        sequenceId={workflowId}
        sequenceName={sequence.name}
        currentStep={3}
        isDraft={isDraft}
      />
      <div className="flex-1 overflow-auto">
        <WorkflowSettingsContent
          workflowId={workflowId}
          basePath="/weldcrm/sequences"
          editorHref={`/weldcrm/sequences/${workflowId}`}
          hideHeader
        />
      </div>
    </div>
  );
}
