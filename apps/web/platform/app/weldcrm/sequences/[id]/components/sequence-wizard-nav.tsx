
import { EditorWizardNav } from '@/components/editor-wizard-nav';
import { useTranslations } from '@weldsuite/i18n/client';
import { GitPullRequest, Users, Settings } from 'lucide-react';

interface SequenceWizardNavProps {
  sequenceId: string;
  sequenceName: string;
  currentStep: number; // 1-based
  isDraft: boolean;
  /** Optional right-side content (e.g. Save/Publish buttons) */
  rightContent?: React.ReactNode;
  /** Intercept navigation — return false to block, true to allow */
  onBeforeNavigate?: (href: string) => boolean;
}

export function SequenceWizardNav({
  sequenceId,
  isDraft,
  rightContent,
  onBeforeNavigate,
  currentStep,
}: SequenceWizardNavProps) {
  const t = useTranslations();
  const basePath = `/weldcrm/sequences/${sequenceId}`;

  const wizardSteps = [
    { label: t('crm.sequenceWizardNav.stepSteps'), href: basePath, icon: GitPullRequest },
    { label: t('crm.sequenceWizardNav.stepPeople'), href: `${basePath}/people`, icon: Users },
    { label: t('crm.sequenceWizardNav.stepSettings'), href: `${basePath}/settings`, icon: Settings },
  ];

  const managementTabs = [
    { label: t('crm.sequenceWizardNav.tabEditor'), href: basePath, icon: GitPullRequest },
    { label: t('crm.sequenceWizardNav.stepPeople'), href: `${basePath}/people`, icon: Users },
    { label: t('crm.sequenceWizardNav.stepSettings'), href: `${basePath}/settings`, icon: Settings },
  ];

  const tabs = isDraft ? wizardSteps : managementTabs;

  return (
    <EditorWizardNav
      tabs={tabs}
      currentStep={currentStep}
      rightContent={rightContent}
      onBeforeNavigate={onBeforeNavigate}
    />
  );
}
