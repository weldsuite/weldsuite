import type { Meta, StoryObj } from "@storybook/react";
import {
  Pencil,
  Copy,
  Play,
  Pause,
  Trash2,
  Users,
} from "lucide-react";

import {
  WorkflowList,
  type WorkflowListItem,
  type WorkflowListGroup,
  type WorkflowListAction,
} from "@weldsuite/ui/components/workflow-list";

const meta = {
  title: "Data Display/WorkflowList",
  component: WorkflowList,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-4xl p-6">
        <div className="rounded-lg border bg-background">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowList>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---- Sample data -----------------------------------------------------------

const workflows: WorkflowListItem[] = [
  {
    id: "wf_1",
    name: "Welcome new customers",
    description: "Send onboarding email when a customer is created",
    status: "active",
    triggerLabel: "Event",
    triggerVariant: "event",
    lastActivityLabel: "12m ago",
  },
  {
    id: "wf_2",
    name: "Nightly invoice sync",
    description: "Push paid invoices to the accounting ledger",
    status: "active",
    triggerLabel: "Schedule",
    triggerVariant: "schedule",
    lastActivityLabel: "3h ago",
  },
  {
    id: "wf_3",
    name: "Stripe payment webhook",
    status: "paused",
    triggerLabel: "Webhook",
    triggerVariant: "webhook",
    lastActivityLabel: "2d ago",
  },
  {
    id: "wf_4",
    name: "Quarterly churn report",
    description: "Draft — not yet published",
    status: "draft",
    triggerLabel: "Manual",
    triggerVariant: "manual",
    lastActivityLabel: "5d ago",
  },
];

const statusGroups: WorkflowListGroup[] = [
  { id: "draft", label: "Draft", sortOrder: 1, match: (w) => w.status === "draft" },
  { id: "active", label: "Active", sortOrder: 2, match: (w) => w.status === "active" },
  { id: "paused", label: "Paused", sortOrder: 3, match: (w) => w.status === "paused" },
];

const actions: WorkflowListAction[] = [
  { id: "edit", label: "Edit", icon: Pencil, onSelect: (w) => alert(`Edit ${w.name}`) },
  { id: "duplicate", label: "Duplicate", icon: Copy, onSelect: (w) => alert(`Duplicate ${w.name}`) },
  {
    id: "activate",
    label: "Activate",
    icon: Play,
    separatorBefore: true,
    hidden: (w) => w.status === "active",
    onSelect: (w) => alert(`Activate ${w.name}`),
  },
  {
    id: "pause",
    label: "Pause",
    icon: Pause,
    separatorBefore: true,
    hidden: (w) => w.status !== "active",
    onSelect: (w) => alert(`Pause ${w.name}`),
  },
  {
    id: "delete",
    label: "Delete",
    icon: Trash2,
    separatorBefore: true,
    destructive: true,
    onSelect: (w) => alert(`Delete ${w.name}`),
  },
];

// ---- Stories ---------------------------------------------------------------

export const GroupedByStatus: Story = {
  args: {
    items: workflows,
    groups: statusGroups,
    actions,
    onSelectItem: (w) => alert(`Open ${w.name}`),
  },
};

export const FlatList: Story = {
  args: {
    items: workflows,
    actions,
    onSelectItem: (w) => alert(`Open ${w.name}`),
  },
};

export const ReadOnly: Story = {
  name: "Read-only (no actions)",
  args: {
    items: workflows,
    groups: statusGroups,
  },
};

/**
 * The WeldCRM "Sequences" surface: no trigger column, a domain-specific
 * "Enrolled" meta column, and sequence-flavoured labels.
 */
export const CrmSequences: Story = {
  name: "CRM Sequences variant",
  args: {
    showTrigger: false,
    labels: { name: "Sequence", lastActivity: "Last Run", meta: "Enrolled" },
    onSelectItem: (w) => alert(`Open ${w.name}`),
    items: [
      {
        id: "seq_1",
        name: "Cold outreach — EU",
        description: "5-step email sequence",
        status: "active",
        lastActivityLabel: "1h ago",
        meta: (
          <span className="font-mono">
            128 <span className="text-green-600 dark:text-green-400">(42 active)</span>
          </span>
        ),
      },
      {
        id: "seq_2",
        name: "Trial follow-up",
        status: "paused",
        lastActivityLabel: "4d ago",
        meta: <span className="font-mono">37</span>,
      },
      {
        id: "seq_3",
        name: "Re-engagement",
        description: "Draft",
        status: "draft",
        lastActivityLabel: "—",
        meta: <span className="font-mono">0</span>,
      },
    ],
    actions: [
      { id: "people", label: "View people", icon: Users, onSelect: () => {} },
      { id: "edit", label: "Edit steps", icon: Pencil, onSelect: () => {} },
      { id: "delete", label: "Delete", icon: Trash2, separatorBefore: true, destructive: true, onSelect: () => {} },
    ],
  },
};

export const Loading: Story = {
  args: {
    items: [],
    isLoading: true,
    actions,
  },
};

export const Empty: Story = {
  args: {
    items: [],
    labels: { name: "Workflow" },
  },
};
