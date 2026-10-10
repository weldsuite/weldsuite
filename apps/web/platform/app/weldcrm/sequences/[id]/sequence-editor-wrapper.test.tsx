import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

/**
 * Regression for TASK-669 (opening a sequence crashed with React #185). The
 * wrapper feeds WorkflowEditorClient, whose canvas effects call setNodes
 * whenever one of its props changes identity. Every non-callback prop the
 * wrapper builds therefore has to keep its identity across re-renders.
 */
const seenProps: Array<Record<string, unknown>> = [];

vi.mock('@/components/workflow-editor', () => ({
  WorkflowEditorClient: (props: Record<string, unknown>) => {
    seenProps.push(props);
    return null;
  },
}));

// Stable translator, like the real hook (memoised per locale).
const translate = (key: string) => key;
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => translate }));

import { SequenceEditorWrapper } from './sequence-editor-wrapper';

const baseProps = {
  sequenceId: 'wf_1',
  workflow: { id: 'wf_1', name: 'Seq' },
  actionTypes: [],
  triggerTypes: [],
  entityEvents: [],
  emailAccounts: [],
  workspaceMembers: [],
  workflowVariables: [],
  workflowsForChaining: [],
  webhookData: null,
} as unknown as React.ComponentProps<typeof SequenceEditorWrapper>;

describe('SequenceEditorWrapper', () => {
  it.each([true, false])('keeps editor props referentially stable across re-renders (isDraft=%s)', (isDraft) => {
    seenProps.length = 0;
    const { rerender } = render(<SequenceEditorWrapper {...baseProps} isDraft={isDraft} />);
    rerender(<SequenceEditorWrapper {...baseProps} isDraft={isDraft} />);
    rerender(<SequenceEditorWrapper {...baseProps} isDraft={isDraft} />);

    expect(seenProps.length).toBeGreaterThanOrEqual(3);
    const [first, ...rest] = seenProps;
    for (const props of rest) {
      expect(props.extraVariableGroups).toBe(first!.extraVariableGroups);
      expect(props.excludeVariableGroups).toBe(first!.excludeVariableGroups);
      expect(props.replaceExecutionsTab).toBe(first!.replaceExecutionsTab);
    }
  });

  it('names the save toast after the sequence, not "Workflow saved"', () => {
    seenProps.length = 0;
    render(<SequenceEditorWrapper {...baseProps} isDraft />);
    expect(seenProps.at(-1)!.savedMessage).toBe('crm.sequenceEditorPage.savedSuccess');
  });

  it('only offers the People tab once the sequence is no longer a draft', () => {
    seenProps.length = 0;
    render(<SequenceEditorWrapper {...baseProps} isDraft />);
    expect(seenProps.at(-1)!.replaceExecutionsTab).toBeUndefined();

    seenProps.length = 0;
    render(<SequenceEditorWrapper {...baseProps} isDraft={false} />);
    expect(seenProps.at(-1)!.replaceExecutionsTab).toMatchObject({ href: '/weldcrm/sequences/wf_1/people' });
  });
});
