import { describe, it, expect, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import { WorkflowCanvas } from '@weldsuite/ui/components/workflow-canvas';
import type { WorkflowCanvasLabels } from '@weldsuite/ui/components/workflow-canvas';

// React Flow measures its container; jsdom has no ResizeObserver.
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    class MockResizeObserver {
      observe() { /* no-op */ }
      unobserve() { /* no-op */ }
      disconnect() { /* no-op */ }
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { writable: true, value: MockResizeObserver });
  }
});

const noop = () => {};

/**
 * Regression for the QA crash "Workflow editor crashes as soon as a trigger is
 * chosen" (React #185). Hosts rebuild `trigger`, `steps` and `labels` inline on
 * every render; the canvas's node-sync effect calls setNodes, so it must treat
 * structurally equal props as unchanged or it re-renders forever.
 */
function Host() {
  return (
    <div style={{ width: 800, height: 600 }}>
      <WorkflowCanvas
        trigger={{ id: 'trigger', type: 'entity_event', name: '', isEnabled: true, config: {} }}
        steps={[{ id: 'step-1', type: 'send_email', name: 'Send email', config: {}, inputs: {} }]}
        onSelectTrigger={noop}
        onSelectStep={noop}
        onDeleteStep={noop}
        onStepsChange={noop}
        onAddStep={noop}
        labels={{ selectTrigger: 'Select a trigger', triggerLabels: {}, actionLabels: {} } as WorkflowCanvasLabels}
        variableItems={[{ path: 'contact.email', label: 'Email', group: 'contact' }]}
      />
    </div>
  );
}

describe('WorkflowCanvas', () => {
  it('does not loop when the host passes new-but-equal props every render', () => {
    expect(() => render(<Host />)).not.toThrow();
  });
});
