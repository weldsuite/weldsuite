import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Heavy siblings in task-detail-content.tsx that the History tab doesn't use.
vi.mock('@/hooks/queries/use-github-queries', () => ({ useLinkedRepos: () => ({ data: [] }) }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({ useWorkspaceMembers: () => ({ data: undefined }) }));
vi.mock('@/hooks/use-file-upload', () => ({ useFileUpload: () => ({}) }));
vi.mock('@/hooks/use-drawer-field-visibility', () => ({
  useDrawerFieldVisibility: () => ({
    isFieldVisible: () => false,
    fields: [],
    fieldVisibility: {},
    toggleField: () => {},
    resetToDefaults: () => {},
  }),
}));
vi.mock('@/app/weldchat/components/emoji-picker', () => ({ EmojiPicker: () => null }));
vi.mock('@/app/weldchat/components/mention-autocomplete', () => ({ MentionAutocomplete: () => null }));
vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (path: string) => path,
}));

const auditPanel = vi.fn((_props: { entityType: string; entityId: string }) => null);
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: (props: { entityType: string; entityId: string }) => auditPanel(props),
}));

import { TaskDetailContent } from './task-detail-content';

function openHistory(projectId?: string) {
  render(
    <TaskDetailContent
      task={{ id: 'task_1', title: 'Call Acme', status: 'todo', createdAt: new Date() }}
      taskId="task_1"
      projectId={projectId}
      onUpdate={vi.fn()}
      availableAssignees={[]}
      availableCompanies={[]}
    />,
  );
  fireEvent.click(screen.getByText('sweep.shared.history'));
}

describe('TaskDetailContent History tab', () => {
  // flow-api `/tasks` publishes every task's events as `project_task`; a
  // project-less CRM task used to query `personal_task` and showed nothing.
  it('reads the project_task audit trail for a task without a project (CRM task)', () => {
    openHistory();
    expect(auditPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ entityType: 'project_task', entityId: 'task_1' }),
    );
  });

  it('reads the project_task audit trail for a project task', () => {
    openHistory('proj_1');
    expect(auditPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ entityType: 'project_task', entityId: 'task_1' }),
    );
  });
});
