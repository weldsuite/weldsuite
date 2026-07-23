import type { WorkflowStep, TriggerConfig, VariableItem } from "@weldsuite/ui/components/workflow-canvas";

// ---- Triggers ---------------------------------------------------------------

export const manualTrigger: TriggerConfig = {
  id: "trig_manual",
  type: "manual",
  name: "Manual Trigger",
  isEnabled: true,
  config: { type: "manual" },
};

export const scheduleTrigger: TriggerConfig = {
  id: "trig_schedule",
  type: "schedule",
  name: "Nightly Run",
  isEnabled: true,
  config: {
    type: "schedule",
    cronExpression: "0 0 * * *",
    timezone: "UTC",
  } as any,
};

export const entityEventTrigger: TriggerConfig = {
  id: "trig_entity",
  type: "entity_event",
  name: "Customer Created",
  isEnabled: true,
  config: {
    type: "entity_event",
    entityType: "customer",
    eventType: "created",
  } as any,
};

// ---- Steps: linear 3-step workflow ------------------------------------------

export const linearSteps: WorkflowStep[] = [
  {
    id: "step_email",
    type: "send_email",
    name: "Welcome Email",
    config: { to: "{{trigger.email}}", subject: "Welcome!" } as any,
    inputs: {},
  },
  {
    id: "step_delay",
    type: "delay",
    name: "Wait 1 day",
    config: { duration: 1, unit: "days" } as any,
    inputs: {},
  },
  {
    id: "step_update",
    type: "update_record",
    name: "Mark Onboarded",
    config: { entityType: "customer" } as any,
    inputs: {},
  },
];

// ---- Steps: condition branching ---------------------------------------------

export const branchingSteps: WorkflowStep[] = [
  {
    id: "step_cond",
    type: "condition",
    name: "Check Status",
    config: {
      expression: "{{trigger.status}} = active",
      field: "{{trigger.status}}",
      operator: "eq",
      value: "active",
    } as any,
    inputs: {},
  },
  {
    id: "step_notify_yes",
    type: "send_notification",
    name: "Notify Active",
    config: {} as any,
    inputs: {},
    parentBranchId: "step_cond_if",
  },
  {
    id: "step_notify_no",
    type: "send_email",
    name: "Send Reactivation",
    config: { to: "{{trigger.email}}", subject: "Come back!" } as any,
    inputs: {},
    parentBranchId: "step_cond_if_not",
  },
];

// ---- Steps: sub-agent workflow ----------------------------------------------

export const subAgentSteps: WorkflowStep[] = [
  {
    id: "step_agent",
    type: "ai_agent",
    name: "Customer Support Agent",
    config: {
      systemPrompt: "You are a helpful customer support agent.",
      subAgentIds: ["subagent_billing", "subagent_shipping"],
      subAgentNames: {
        subagent_billing: "Billing Agent",
        subagent_shipping: "Shipping Agent",
      },
    } as any,
    inputs: {},
  },
];

// ---- Variable items ---------------------------------------------------------

export const sampleVariables: VariableItem[] = [
  { path: "trigger.email", label: "Email", group: "Trigger" },
  { path: "trigger.firstName", label: "First Name", group: "Trigger" },
  { path: "trigger.lastName", label: "Last Name", group: "Trigger" },
  { path: "trigger.companyName", label: "Company", group: "Trigger" },
  { path: "steps.step_email.success", label: "Email Sent", group: "Step 1: Welcome Email", type: "boolean" },
  { path: "steps.step_email.messageId", label: "Message ID", group: "Step 1: Welcome Email", type: "string" },
];
