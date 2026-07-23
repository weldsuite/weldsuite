import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import * as React from "react";

import { WorkflowCanvas } from "@weldsuite/ui/components/workflow-canvas";
import {
  manualTrigger,
  scheduleTrigger,
  entityEventTrigger,
  linearSteps,
  branchingSteps,
  subAgentSteps,
  sampleVariables,
} from "./workflow-canvas.mocks";

const meta = {
  title: "Data Display/Workflow Canvas",
  component: WorkflowCanvas,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ height: "100vh" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    onSelectTrigger: fn(),
    onSelectStep: fn(),
    onSelectBranch: fn(),
    onDeleteStep: fn(),
    onStepsChange: fn(),
    onAddStep: fn(),
    onUpdateConfig: fn(),
    onAddSubAgent: fn(),
    onEditSubAgent: fn(),
    onDeselect: fn(),
    onNotify: fn(),
  },
} satisfies Meta<typeof WorkflowCanvas>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---- Stories ----------------------------------------------------------------

/** Empty canvas — no trigger set, no steps. The placeholder add button is visible. */
export const Empty: Story = {
  args: {
    trigger: null,
    steps: [],
    selectedNodeId: null,
  },
};

/** Manual trigger + 3 sequential action nodes (send_email → delay → update_record). */
export const LinearWorkflow: Story = {
  args: {
    trigger: manualTrigger,
    steps: linearSteps,
    selectedNodeId: null,
  },
};

/** Entity-event trigger + condition node splitting into two branches. */
export const WithConditionBranching: Story = {
  args: {
    trigger: entityEventTrigger,
    steps: branchingSteps,
    selectedNodeId: null,
  },
};

/** Schedule trigger + AI sub-agent node with two satellite sub-agents. */
export const WithSubAgent: Story = {
  args: {
    trigger: scheduleTrigger,
    steps: subAgentSteps,
    selectedNodeId: null,
  },
};

/** triggerLocked: true to demo the WeldCRM sequence-editor pose. */
export const SequenceMode: Story = {
  args: {
    trigger: manualTrigger,
    steps: linearSteps,
    triggerLocked: true,
    selectedNodeId: null,
  },
};

/** Populated variableItems to demo the variable picker inside email nodes. */
export const WithVariables: Story = {
  args: {
    trigger: entityEventTrigger,
    steps: linearSteps,
    variableItems: sampleVariables,
    selectedNodeId: null,
  },
};
