'use client';

import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { ActionDialog } from '@/components/billing/action-dialog';
import {
  dismissReport,
  markReportActioned,
  releaseHeldForm,
  suspendForm,
  suspendWorkspaceForms,
  unsuspendForm,
} from '@/actions/weldforms';

type Dialog = 'suspend' | 'unsuspend' | 'release' | 'dismiss' | 'actioned' | 'workspace' | null;

/**
 * The moderation buttons of one row: a form (public id), optionally the abuse
 * report it came from. Which buttons show follows the form's and the report's
 * state; staff who cannot write see none.
 */
export function ModerationActions({
  canWrite,
  publicId,
  workspaceId,
  workspaceName,
  suspended,
  held,
  linkExists = true,
  reportId,
  reportOpen = false,
}: Readonly<{
  canWrite: boolean;
  publicId: string;
  workspaceId: string;
  workspaceName: string | null;
  suspended: boolean;
  held: boolean;
  linkExists?: boolean;
  reportId?: string;
  reportOpen?: boolean;
}>) {
  const [dialog, setDialog] = useState<Dialog>(null);
  if (!canWrite) return null;
  const close = () => setDialog(null);
  const workspace = workspaceName ?? workspaceId;

  const button = (label: string, kind: Exclude<Dialog, null>, destructive = false) => (
    <Button
      key={kind}
      size="sm"
      variant={destructive ? 'destructive' : 'outline'}
      className="h-7 px-2.5 text-xs"
      onClick={() => setDialog(kind)}
    >
      {label}
    </Button>
  );

  return (
    <div className="flex flex-wrap gap-1.5">
      {linkExists && !suspended && button('Suspend form', 'suspend', true)}
      {linkExists && suspended && button('Unsuspend', 'unsuspend')}
      {linkExists && held && !suspended && button('Release', 'release')}
      {reportId && reportOpen && button('Dismiss', 'dismiss')}
      {reportId && reportOpen && button('Mark actioned', 'actioned')}
      {button('Suspend workspace forms', 'workspace')}

      {dialog === 'suspend' && (
        <ActionDialog
          title={`Suspend form ${publicId}`}
          description={
            reportId
              ? 'Respondents see "no longer available" at once. The report is marked actioned. The reason is kept in the activity log.'
              : 'Respondents see "no longer available" at once. The form and its responses stay in the workspace. The reason is kept in the activity log.'
          }
          submitLabel="Suspend form"
          destructive
          onClose={close}
          onSubmit={(reason) => suspendForm(publicId, reason, reportId)}
          successMessage="Form suspended"
        />
      )}
      {dialog === 'unsuspend' && (
        <ActionDialog
          title={`Unsuspend form ${publicId}`}
          description="The form answers respondents again (unless it is also held). The reason is kept in the activity log."
          submitLabel="Unsuspend"
          onClose={close}
          onSubmit={(reason) => unsuspendForm(publicId, reason)}
          successMessage="Form unsuspended"
        />
      )}
      {dialog === 'release' && (
        <ActionDialog
          title={`Release held form ${publicId}`}
          description="The publish content screen held this form for review. Releasing it opens the form to respondents. The reason is kept in the activity log."
          submitLabel="Release form"
          onClose={close}
          onSubmit={(reason) => releaseHeldForm(publicId, reason)}
          successMessage="Form released"
        />
      )}
      {dialog === 'dismiss' && reportId && (
        <ActionDialog
          title="Dismiss report"
          description="The report is closed as not a problem; the form is left as it is. The reason is kept in the activity log."
          submitLabel="Dismiss report"
          onClose={close}
          onSubmit={(reason) => dismissReport(reportId, reason)}
          successMessage="Report dismissed"
        />
      )}
      {dialog === 'actioned' && reportId && (
        <ActionDialog
          title="Mark report actioned"
          description="Close the report as dealt with, for example after warning the workspace. This does not suspend the form. The reason is kept in the activity log."
          submitLabel="Mark actioned"
          onClose={close}
          onSubmit={(reason) => markReportActioned(reportId, reason)}
          successMessage="Report marked actioned"
        />
      )}
      {dialog === 'workspace' && (
        <ActionDialog
          title={`Suspend every public form of ${workspace}`}
          description="All public forms of this workspace that are not suspended stop answering at once. Use it for a workspace that is abusing WeldForms. The reason is kept in the activity log."
          submitLabel="Suspend all forms"
          destructive
          onClose={close}
          onSubmit={(reason) => suspendWorkspaceForms(workspaceId, reason)}
          successMessage={(data) => `${data.suspended} ${data.suspended === 1 ? 'form' : 'forms'} suspended`}
        />
      )}
    </div>
  );
}
