
import { Users, User } from 'lucide-react';
import { WorkflowEditorClient } from '@/components/workflow-editor';
import type { ComponentProps } from 'react';
import type { VariableGroup } from '@weldsuite/ui/components/workflow-canvas/parts/variable-picker';
import { useTranslations } from '@weldsuite/i18n/client';

type EditorProps = Omit<ComponentProps<typeof WorkflowEditorClient>, 'editorHref' | 'replaceExecutionsTab' | 'triggerLocked' | 'extraVariableGroups' | 'excludeVariableGroups' | 'publishLabel' | 'onPublish' | 'hidePublish' | 'hideNavTabs'> & {
  sequenceId: string;
  isDraft?: boolean;
  actionsPortalRef?: React.RefObject<HTMLDivElement | null>;
  onDirtyChange?: (isDirty: boolean) => void;
};

export function SequenceEditorWrapper({ sequenceId, isDraft = false, actionsPortalRef, onDirtyChange, ...props }: EditorProps) {
  const t = useTranslations();
  const contactVariableGroup: VariableGroup = {
    id: 'contact',
    label: t('sweep.weldcrm.sequenceEditorWrapper.variableGroups.customer'),
    icon: <User className="h-4 w-4 text-emerald-500" />,
    variables: [
      { path: 'contact.firstName', label: t('sweep.weldcrm.sequenceEditorWrapper.variables.firstName'), type: 'string' },
      { path: 'contact.lastName', label: t('sweep.weldcrm.sequenceEditorWrapper.variables.lastName'), type: 'string' },
      { path: 'contact.fullName', label: t('sweep.weldcrm.sequenceEditorWrapper.variables.fullName'), type: 'string' },
      { path: 'contact.email', label: t('sweep.weldcrm.sequenceEditorWrapper.variables.email'), type: 'string' },
      { path: 'contact.phone', label: t('sweep.weldcrm.sequenceEditorWrapper.variables.phone'), type: 'string' },
      { path: 'contact.companyName', label: t('sweep.weldcrm.sequenceEditorWrapper.variables.companyName'), type: 'string' },
      { path: 'contact.jobTitle', label: t('sweep.weldcrm.sequenceEditorWrapper.variables.jobTitle'), type: 'string' },
      { path: 'contact.city', label: t('sweep.weldcrm.sequenceEditorWrapper.variables.city'), type: 'string' },
      { path: 'contact.country', label: t('sweep.weldcrm.sequenceEditorWrapper.variables.country'), type: 'string' },
    ],
  };
  // Always hide built-in nav tabs — wizard nav (draft) or sequence nav (active) handles navigation
  // Pause/Resume buttons are rendered by the parent page in the wizard nav's rightContent
  const draftOverrides = isDraft
    ? {
        hideNavTabs: true,
        hidePublish: true,
        replaceExecutionsTab: undefined as { label: string; href: string; icon: any } | undefined,
      }
    : {
        hideNavTabs: true,
        hidePublish: true,
        replaceExecutionsTab: { label: t('sweep.weldcrm.sequenceEditorWrapper.peopleTab'), href: `/weldcrm/sequences/${sequenceId}/people`, icon: Users },
      };

  return (
    <WorkflowEditorClient
      {...props}
      editorHref={`/weldcrm/sequences/${sequenceId}`}
      triggerLocked
      extraVariableGroups={[contactVariableGroup]}
      excludeVariableGroups={['trigger', 'env']}
      actionsPortalRef={actionsPortalRef}
      onDirtyChange={onDirtyChange}
      {...draftOverrides}
    />
  );
}
