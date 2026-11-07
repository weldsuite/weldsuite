/**
 * The campaign sequence as WeldConnect's workflow canvas draws it: a locked
 * start node, a Wait node before every follow-up that waits, and each email as
 * the canvas's compose-window card. Pure, so the mapping is tested on its own.
 */

import type { ReachStepInput } from '@weldsuite/app-api-client/schemas/reach';
import type { TriggerConfig, WorkflowStep } from '@weldsuite/ui/components/workflow-canvas';

/** The texts the canvas shows, already translated by the caller. */
export interface SequenceCanvasText {
  start: string;
  stepName: (index: number) => string;
  wait: string;
  waitSummary: (days: number, hours: number) => string;
  from: string;
  fromValue: string;
  to: string;
  toValue: string;
  subject: string;
  subjectPlaceholder: string;
  bodyPlaceholder: string;
}

export type SequenceNodePart = 'wait' | 'email';

export interface SequenceCanvas {
  trigger: TriggerConfig;
  steps: WorkflowStep[];
  /** For each canvas step, the sequence step it belongs to and which part it draws. */
  nodes: Array<{ index: number; part: SequenceNodePart }>;
}

export function sequenceNodeId(key: string, part: SequenceNodePart): string {
  return `${part}-${key}`;
}

/** A follow-up waits when it has a delay; the first email and a zero delay get no Wait node. */
function waits(step: ReachStepInput, index: number): boolean {
  return index > 0 && (Number(step.delayDays) > 0 || Number(step.delayHours) > 0);
}

/**
 * `keys` are stable per step (the form's field ids), so a node keeps its place
 * on the canvas when steps before it are added, moved or removed.
 */
export function sequenceToCanvas(
  steps: ReachStepInput[],
  keys: string[],
  text: SequenceCanvasText,
): SequenceCanvas {
  const canvasSteps: WorkflowStep[] = [];
  const nodes: SequenceCanvas['nodes'] = [];

  steps.forEach((step, index) => {
    const key = keys[index] ?? String(index);
    if (waits(step, index)) {
      const days = Number(step.delayDays) || 0;
      const hours = Number(step.delayHours) || 0;
      canvasSteps.push({
        id: sequenceNodeId(key, 'wait'),
        type: 'delay',
        name: text.wait,
        summary: text.waitSummary(days, hours),
        config: { days, hours },
        inputs: {},
      });
      nodes.push({ index, part: 'wait' });
    }

    canvasSteps.push({
      id: sequenceNodeId(key, 'email'),
      type: 'send_email',
      name: text.stepName(index),
      // The canvas marks an email without a subject or body as "Setup required".
      config: { to: text.toValue, subject: step.subject, body: step.body },
      inputs: {},
      emailPreview: {
        rows: [
          { label: text.from, value: text.fromValue },
          { label: text.to, value: text.toValue },
          { label: text.subject, value: step.subject, placeholder: text.subjectPlaceholder },
        ],
        body: step.body,
        bodyPlaceholder: text.bodyPlaceholder,
      },
    });
    nodes.push({ index, part: 'email' });
  });

  return {
    trigger: { id: 'trigger', type: 'manual', name: text.start, isEnabled: true, config: {} },
    steps: canvasSteps,
    nodes,
  };
}

/** The sequence step a canvas node id belongs to; the start node and unknown ids give `null`. */
export function stepIndexForNode(canvas: SequenceCanvas, nodeId: string | undefined): number | null {
  const position = canvas.steps.findIndex((step) => step.id === nodeId);
  return position === -1 ? null : (canvas.nodes[position]?.index ?? null);
}
