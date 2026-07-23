
import * as React from "react";
import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useReactFlow,
  Panel,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@weldsuite/ui/components/dialog";
import { Input } from "@weldsuite/ui/components/input";
import { Button } from "@weldsuite/ui/components/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@weldsuite/ui/components/sidebar";
import {
  Search,
  Zap,
  Mail,
  FileText,
  Database,
  Clock,
  Bell,
  Users,
  ArrowRight,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  Webhook,
  Send,
  Sparkles,
  LayoutGrid,
  Plug,
  CalendarClock,
  X,
  ChevronLeft,
  ShoppingCart,
  UserPlus,
  BarChart3,
  Shield,
  Package,
  Target,
  ListTodo,
  Forward,
  HardDrive,
  Globe,
  Brain,
  FileSearch,
  MessageSquare,
  Repeat,
  Bot,
  Trash2,
  GitBranch,
  Pencil,
  Plus,
  Variable,
  Wand2,
  Code,
  Calendar,
  MousePointerClick,
  GitMerge,
  Minus,
  Maximize,
} from "lucide-react";
import { Badge } from "@weldsuite/ui/components/badge";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/provider";
import { useTranslations } from "@weldsuite/i18n/client";
import { TriggerNode, ActionNode, PlaceholderNode, ConditionNode, ConditionBranchNode, workflowToFlow } from '@weldsuite/ui/components/workflow-canvas';
import type { WorkflowStep, TriggerConfig } from '@weldsuite/ui/components/workflow-canvas';

export interface TemplateStep {
  id: string;
  type: string;
  name: string;
  description?: string;
  config: Record<string, any>;
  parentBranchId?: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  longDescription?: string;
  icon: React.ElementType;
  category: string;
  steps: number;
  color: string;
  requiredObjects?: string[];
  requiredIntegrations?: string[];
  trigger: {
    type: string;
    [key: string]: any;
  };
  workflowSteps: TemplateStep[];
}

export const CATEGORIES = [
  { id: "all", label: "All templates", icon: LayoutGrid },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "data-sync", label: "Data Sync", icon: RefreshCw },
  { id: "automation", label: "Automation", icon: Zap },
  { id: "scheduling", label: "Scheduling", icon: CalendarClock },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "communication", label: "Communication", icon: Send },
];

// Icons for each action step type (matches action-node.tsx)
export const stepActionIcons: Record<string, React.ElementType> = {
  send_email: Mail,
  http_request: Globe,
  delay: Clock,
  condition: GitBranch,
  loop: Repeat,
  set_variable: Variable,
  transform_data: Wand2,
  create_record: Plus,
  update_record: Pencil,
  delete_record: Trash2,
  query_data: Search,
  send_notification: Bell,
  run_script: Code,
  ai_generate: Sparkles,
  ai_extract: FileSearch,
  ai_summarize: FileText,
  log_message: MessageSquare,
};

// Icon colors for each action type
export const stepIconColors: Record<string, { bg: string; text: string }> = {
  send_email: { bg: "bg-blue-100", text: "text-blue-600" },
  http_request: { bg: "bg-purple-100", text: "text-purple-600" },
  delay: { bg: "bg-amber-100", text: "text-amber-600" },
  condition: { bg: "bg-orange-100", text: "text-orange-600" },
  loop: { bg: "bg-cyan-100", text: "text-cyan-600" },
  set_variable: { bg: "bg-indigo-100", text: "text-indigo-600" },
  transform_data: { bg: "bg-violet-100", text: "text-violet-600" },
  create_record: { bg: "bg-green-100", text: "text-green-600" },
  update_record: { bg: "bg-teal-100", text: "text-teal-600" },
  delete_record: { bg: "bg-red-100", text: "text-red-600" },
  query_data: { bg: "bg-emerald-100", text: "text-emerald-600" },
  send_notification: { bg: "bg-pink-100", text: "text-pink-600" },
  run_script: { bg: "bg-gray-100", text: "text-gray-600" },
  ai_generate: { bg: "bg-violet-100", text: "text-violet-600" },
  ai_extract: { bg: "bg-indigo-100", text: "text-indigo-600" },
  ai_summarize: { bg: "bg-purple-100", text: "text-purple-600" },
  log_message: { bg: "bg-gray-100", text: "text-gray-600" },
};

// Icons for trigger types
export const triggerIcons: Record<string, React.ElementType> = {
  entity_event: Zap,
  schedule: Calendar,
  workflow_complete: GitMerge,
  webhook: Webhook,
  manual: MousePointerClick,
};

export const builtInTemplates: WorkflowTemplate[] = [
  // ============================================================================
  // NOTIFICATIONS
  // ============================================================================
  {
    id: "email-notification",
    name: "Email Notification",
    description: "Send email notifications when events occur",
    longDescription: "Automatically send personalized email notifications to team members or customers when specific events occur. Configure triggers, customize email content with dynamic variables, and set delivery rules.",
    icon: Mail,
    category: "notifications",
    steps: 2,
    color: "blue",
    requiredObjects: ["Contact"],
    requiredIntegrations: ["Email"],
    trigger: { type: "entity_event", entityType: "contact", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "log_message",
        name: "Log Event",
        description: "Logs the incoming contact event for debugging and audit purposes",
        config: { message: "New contact event received: {{trigger.data.email}}", level: "info" },
      },
      {
        id: "s2",
        type: "send_email",
        name: "Send Notification Email",
        description: "Sends a personalized welcome email to the new contact",
        config: {
          to: "{{trigger.data.email}}",
          subject: "Welcome to our platform",
          body: "<p>Hi {{trigger.data.name}},</p><p>Welcome! We're excited to have you on board.</p><p>Best regards,<br/>The Team</p>",
          isHtml: true,
        },
      },
    ],
  },
  {
    id: "threshold-alert",
    name: "Threshold Alert",
    description: "Alert when metrics exceed defined thresholds",
    longDescription: "Monitor key metrics on a schedule and receive instant alerts when values exceed your defined thresholds. Perfect for monitoring inventory levels, sales targets, or any quantifiable metric.",
    icon: AlertTriangle,
    category: "notifications",
    steps: 3,
    color: "red",
    requiredObjects: ["Metric"],
    requiredIntegrations: ["Email"],
    trigger: { type: "schedule", scheduleType: "recurring", cronExpression: "*/15 * * * *", timezone: "Europe/Amsterdam" },
    workflowSteps: [
      {
        id: "s1",
        type: "query_data",
        name: "Check Metric Value",
        description: "Queries product data to check current metric values",
        config: { entityType: "product", filters: [] },
      },
      {
        id: "s2",
        type: "condition",
        name: "Threshold Exceeded?",
        description: "Evaluates whether the metric exceeds the defined threshold",
        config: { field: "{{steps.s1.count}}", operator: "greater_than", value: "100" },
      },
      {
        id: "s3",
        type: "send_notification",
        name: "Send Alert",
        description: "Sends a notification alert to the team about the threshold breach",
        parentBranchId: "s2_if",
        config: {
          title: "Threshold Alert",
          message: "The monitored metric has exceeded the configured threshold. Current value: {{steps.s1.count}}",
          recipients: [],
        },
      },
    ],
  },
  {
    id: "sla-breach-alert",
    name: "SLA Breach Alert",
    description: "Alert when support tickets breach SLA deadlines",
    longDescription: "Monitor support tickets on a regular schedule and automatically alert your team when tickets are approaching or have breached their SLA deadlines. Includes escalation notification via email.",
    icon: Shield,
    category: "notifications",
    steps: 4,
    color: "orange",
    requiredObjects: ["Ticket"],
    requiredIntegrations: ["Email"],
    trigger: { type: "schedule", scheduleType: "recurring", cronExpression: "0 * * * *", timezone: "Europe/Amsterdam" },
    workflowSteps: [
      {
        id: "s1",
        type: "query_data",
        name: "Find Overdue Tickets",
        description: "Queries for support tickets that have breached their SLA deadlines",
        config: { entityType: "ticket", filters: [] },
      },
      {
        id: "s2",
        type: "condition",
        name: "Any Overdue?",
        description: "Checks if any overdue tickets were found",
        config: { field: "{{steps.s1.count}}", operator: "greater_than", value: "0" },
      },
      {
        id: "s3",
        type: "send_notification",
        name: "Notify Team",
        description: "Sends an in-app notification to the support team",
        parentBranchId: "s2_if",
        config: {
          title: "SLA Breach Warning",
          message: "{{steps.s1.count}} ticket(s) have breached or are approaching SLA deadlines. Please review immediately.",
          recipients: [],
        },
      },
      {
        id: "s4",
        type: "send_email",
        name: "Escalation Email",
        description: "Sends an escalation email to the manager with breach details",
        parentBranchId: "s2_if",
        config: {
          to: "manager@company.com",
          subject: "SLA Breach Alert - {{steps.s1.count}} tickets overdue",
          body: "<p>Hi,</p><p><strong>{{steps.s1.count}}</strong> support ticket(s) have breached their SLA deadlines and require immediate attention.</p><p>Please review the helpdesk dashboard for details.</p>",
          isHtml: true,
        },
      },
    ],
  },
  {
    id: "low-stock-alert",
    name: "Low Stock Alert",
    description: "Alert when inventory drops below minimum levels",
    longDescription: "Automatically monitor your product inventory levels on a schedule. When stock drops below the configured minimum threshold, receive instant notifications and email alerts to reorder.",
    icon: Package,
    category: "notifications",
    steps: 3,
    color: "amber",
    requiredObjects: ["Product"],
    requiredIntegrations: ["Email"],
    trigger: { type: "schedule", scheduleType: "recurring", cronExpression: "0 8 * * *", timezone: "Europe/Amsterdam" },
    workflowSteps: [
      {
        id: "s1",
        type: "query_data",
        name: "Check Low Stock Products",
        description: "Queries products with stock below minimum levels",
        config: { entityType: "product", filters: [] },
      },
      {
        id: "s2",
        type: "condition",
        name: "Stock Below Minimum?",
        description: "Checks if any products are below their reorder threshold",
        config: { field: "{{steps.s1.count}}", operator: "greater_than", value: "0" },
      },
      {
        id: "s3",
        type: "send_email",
        name: "Send Low Stock Report",
        description: "Emails the purchasing team with a list of products to reorder",
        parentBranchId: "s2_if",
        config: {
          to: "purchasing@company.com",
          subject: "Low Stock Alert - {{steps.s1.count}} products need reordering",
          body: "<p>The following products are below their minimum stock levels and need to be reordered:</p><p>{{steps.s1.data}}</p><p>Please review and place orders as needed.</p>",
          isHtml: true,
        },
      },
    ],
  },
  {
    id: "error-webhook-alert",
    name: "Error Webhook Alert",
    description: "Receive error webhooks and notify the team",
    longDescription: "Set up an endpoint to receive error webhooks from external services. Automatically filter by severity, notify the appropriate team, and log the error for debugging.",
    icon: AlertTriangle,
    category: "notifications",
    steps: 3,
    color: "red",
    requiredObjects: [],
    requiredIntegrations: [],
    trigger: { type: "webhook" },
    workflowSteps: [
      {
        id: "s1",
        type: "log_message",
        name: "Log Error",
        description: "Logs the incoming error webhook payload for debugging",
        config: { message: "Error webhook received: {{trigger.data}}", level: "error" },
      },
      {
        id: "s2",
        type: "condition",
        name: "Is Critical?",
        description: "Checks if the error severity is critical",
        config: { field: "{{trigger.data.severity}}", operator: "equals", value: "critical" },
      },
      {
        id: "s3",
        type: "send_notification",
        name: "Alert Team",
        description: "Sends an urgent notification to the team about the critical error",
        parentBranchId: "s2_if",
        config: {
          title: "Critical Error Alert",
          message: "A critical error has been reported: {{trigger.data.message}}",
          recipients: [],
        },
      },
    ],
  },

  // ============================================================================
  // DATA SYNC
  // ============================================================================
  {
    id: "record-sync",
    name: "Record Sync",
    description: "Keep records synchronized between systems",
    longDescription: "Ensure data consistency by automatically synchronizing records when they change. When a record is updated, this workflow queries the target system and updates the corresponding record.",
    icon: RefreshCw,
    category: "data-sync",
    steps: 3,
    color: "cyan",
    requiredObjects: ["Source Record", "Target Record"],
    requiredIntegrations: [],
    trigger: { type: "entity_event", entityType: "contact", eventType: "updated" },
    workflowSteps: [
      {
        id: "s1",
        type: "query_data",
        name: "Find Target Record",
        description: "Looks up the corresponding record in the target system",
        config: { entityType: "contact", filters: [] },
      },
      {
        id: "s2",
        type: "update_record",
        name: "Update Target Record",
        description: "Syncs the changed fields to the target record",
        config: {
          entityType: "contact",
          recordId: "{{steps.s1.data.id}}",
          fields: [
            { field: "name", value: "{{trigger.data.name}}" },
            { field: "email", value: "{{trigger.data.email}}" },
          ],
        },
      },
      {
        id: "s3",
        type: "log_message",
        name: "Log Sync Result",
        description: "Logs the sync operation result for audit tracking",
        config: { message: "Record synced successfully: {{trigger.data.id}} -> {{steps.s1.data.id}}", level: "info" },
      },
    ],
  },
  {
    id: "data-cleanup",
    name: "Data Cleanup",
    description: "Automatically clean up old or unused records",
    longDescription: "Schedule automatic data cleanup to remove outdated records. Queries for records matching your criteria, loops through them, and deletes each one while logging the operation.",
    icon: Trash2,
    category: "data-sync",
    steps: 3,
    color: "pink",
    requiredObjects: ["Record"],
    requiredIntegrations: [],
    trigger: { type: "schedule", scheduleType: "recurring", cronExpression: "0 2 * * 0", timezone: "Europe/Amsterdam" },
    workflowSteps: [
      {
        id: "s1",
        type: "query_data",
        name: "Find Old Records",
        description: "Queries for records that match the cleanup criteria",
        config: { entityType: "contact", filters: [] },
      },
      {
        id: "s2",
        type: "loop",
        name: "Process Each Record",
        description: "Iterates through each matching record for processing",
        config: { source: "{{steps.s1.data}}", variable: "record" },
      },
      {
        id: "s3",
        type: "log_message",
        name: "Log Cleanup",
        description: "Logs a summary of the cleanup operation",
        config: { message: "Data cleanup completed. Processed {{steps.s1.count}} records.", level: "info" },
      },
    ],
  },
  {
    id: "data-enrichment",
    name: "Data Enrichment",
    description: "Enrich new records with data from external APIs",
    longDescription: "When a new record is created, automatically call an external API to enrich it with additional data. Transform the response and update the record with the enriched information.",
    icon: Database,
    category: "data-sync",
    steps: 3,
    color: "green",
    requiredObjects: ["Record"],
    requiredIntegrations: ["REST API"],
    trigger: { type: "entity_event", entityType: "contact", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "http_request",
        name: "Call Enrichment API",
        description: "Calls an external API to fetch additional data for the new record",
        config: {
          method: "GET",
          url: "https://api.example.com/enrich?email={{trigger.data.email}}",
          headers: [{ key: "Authorization", value: "Bearer YOUR_API_KEY" }],
          timeout: 10000,
        },
      },
      {
        id: "s2",
        type: "transform_data",
        name: "Map API Response",
        description: "Transforms the API response into the correct field format",
        config: {
          mappings: [
            { source: "{{steps.s1.response.company}}", target: "company" },
            { source: "{{steps.s1.response.title}}", target: "jobTitle" },
            { source: "{{steps.s1.response.location}}", target: "location" },
          ],
        },
      },
      {
        id: "s3",
        type: "update_record",
        name: "Update with Enriched Data",
        description: "Updates the record with the enriched information",
        config: {
          entityType: "contact",
          recordId: "{{trigger.data.id}}",
          fields: [
            { field: "company", value: "{{steps.s2.company}}" },
            { field: "jobTitle", value: "{{steps.s2.jobTitle}}" },
          ],
        },
      },
    ],
  },
  {
    id: "periodic-import",
    name: "Periodic Import",
    description: "Import data from external APIs on a schedule",
    longDescription: "Automatically import data from external APIs on a recurring schedule. Fetch data, transform it to match your schema, and create new records for each item in the response.",
    icon: Repeat,
    category: "data-sync",
    steps: 4,
    color: "teal",
    requiredObjects: ["Record"],
    requiredIntegrations: ["REST API"],
    trigger: { type: "schedule", scheduleType: "recurring", cronExpression: "0 */6 * * *", timezone: "Europe/Amsterdam" },
    workflowSteps: [
      {
        id: "s1",
        type: "http_request",
        name: "Fetch External Data",
        description: "Fetches data from the external API endpoint",
        config: {
          method: "GET",
          url: "https://api.example.com/data",
          headers: [{ key: "Authorization", value: "Bearer YOUR_API_KEY" }],
          timeout: 30000,
        },
      },
      {
        id: "s2",
        type: "transform_data",
        name: "Transform Response",
        description: "Transforms the API response to match the local data schema",
        config: {
          mappings: [
            { source: "{{steps.s1.response.items}}", target: "records" },
          ],
        },
      },
      {
        id: "s3",
        type: "loop",
        name: "Import Each Record",
        description: "Loops through each item and creates a local record",
        config: { source: "{{steps.s2.records}}", variable: "item" },
      },
      {
        id: "s4",
        type: "log_message",
        name: "Log Import",
        description: "Logs a summary of the import operation",
        config: { message: "Periodic import completed successfully.", level: "info" },
      },
    ],
  },

  // ============================================================================
  // AUTOMATION
  // ============================================================================
  {
    id: "entity-automation",
    name: "Entity Automation",
    description: "Automate actions on entity changes",
    longDescription: "Trigger automated actions whenever entities are created, updated, or deleted. Build complex automation rules that respond to changes in your data, with conditional logic and notifications.",
    icon: Zap,
    category: "automation",
    steps: 3,
    color: "amber",
    requiredObjects: ["Entity"],
    requiredIntegrations: [],
    trigger: { type: "entity_event", entityType: "contact", eventType: "updated" },
    workflowSteps: [
      {
        id: "s1",
        type: "condition",
        name: "Check Condition",
        description: "Evaluates whether the entity meets the automation criteria",
        config: { field: "{{trigger.data.status}}", operator: "equals", value: "active" },
      },
      {
        id: "s2",
        type: "update_record",
        name: "Update Record",
        description: "Updates the entity record with the automated changes",
        parentBranchId: "s1_if",
        config: {
          entityType: "contact",
          recordId: "{{trigger.data.id}}",
          fields: [{ field: "processedAt", value: "{{now}}" }],
        },
      },
      {
        id: "s3",
        type: "send_notification",
        name: "Notify Team",
        description: "Sends a notification that the entity was processed",
        parentBranchId: "s1_if",
        config: {
          title: "Entity Updated",
          message: "Record {{trigger.data.id}} has been processed automatically.",
          recipients: [],
        },
      },
    ],
  },
  {
    id: "approval-workflow",
    name: "Approval Workflow",
    description: "Multi-step approval processes with notifications",
    longDescription: "Create structured approval workflows with email notifications, waiting periods, and conditional outcomes. Send approval requests, wait for responses, and update records based on the decision.",
    icon: CheckCircle,
    category: "automation",
    steps: 5,
    color: "emerald",
    requiredObjects: ["Approval Request"],
    requiredIntegrations: ["Email"],
    trigger: { type: "entity_event", entityType: "order", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "send_email",
        name: "Request Approval",
        description: "Sends an approval request email to the designated approver",
        config: {
          to: "approver@company.com",
          subject: "Approval Required: {{trigger.data.name}}",
          body: "<p>A new item requires your approval:</p><p><strong>{{trigger.data.name}}</strong></p><p>Amount: {{trigger.data.total}}</p><p>Please review and respond.</p>",
          isHtml: true,
        },
      },
      {
        id: "s2",
        type: "send_notification",
        name: "Notify Requester",
        description: "Notifies the original requester that approval has been requested",
        config: {
          title: "Approval Requested",
          message: "Your request '{{trigger.data.name}}' has been sent for approval.",
          recipients: [],
        },
      },
      {
        id: "s3",
        type: "delay",
        name: "Wait for Response",
        description: "Pauses the workflow for 24 hours to allow time for review",
        config: { duration: 24, unit: "hours" },
      },
      {
        id: "s4",
        type: "condition",
        name: "Check Approval Status",
        description: "Checks whether the request was approved or rejected",
        config: { field: "{{trigger.data.status}}", operator: "equals", value: "approved" },
      },
      {
        id: "s5",
        type: "update_record",
        name: "Update Status",
        description: "Updates the record status to processed after approval",
        parentBranchId: "s4_if",
        config: {
          entityType: "order",
          recordId: "{{trigger.data.id}}",
          fields: [{ field: "status", value: "processed" }],
        },
      },
    ],
  },
  {
    id: "user-onboarding",
    name: "User Onboarding",
    description: "Automate new user onboarding steps",
    longDescription: "Streamline the user onboarding process with automated workflows. Send welcome emails, create setup records, wait for account activation, and follow up with helpful resources.",
    icon: UserPlus,
    category: "automation",
    steps: 5,
    color: "teal",
    requiredObjects: ["User"],
    requiredIntegrations: ["Email"],
    trigger: { type: "entity_event", entityType: "contact", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "send_email",
        name: "Send Welcome Email",
        description: "Sends a personalized welcome email with getting started tips",
        config: {
          to: "{{trigger.data.email}}",
          subject: "Welcome aboard, {{trigger.data.name}}!",
          body: "<p>Hi {{trigger.data.name}},</p><p>Welcome to our platform! We're thrilled to have you.</p><p>Here are a few things to get you started:</p><ul><li>Complete your profile</li><li>Explore the dashboard</li><li>Check out our help center</li></ul><p>Best,<br/>The Team</p>",
          isHtml: true,
        },
      },
      {
        id: "s2",
        type: "create_record",
        name: "Create Onboarding Task",
        description: "Creates a task to track the user's onboarding progress",
        config: {
          entityType: "task",
          fields: [
            { field: "title", value: "Complete onboarding for {{trigger.data.name}}" },
            { field: "assignee", value: "{{trigger.data.id}}" },
            { field: "status", value: "pending" },
          ],
        },
      },
      {
        id: "s3",
        type: "delay",
        name: "Wait 3 Days",
        description: "Waits 3 days before sending the follow-up",
        config: { duration: 3, unit: "days" },
      },
      {
        id: "s4",
        type: "send_email",
        name: "Follow-up Email",
        description: "Sends a check-in email to see if the user needs help",
        config: {
          to: "{{trigger.data.email}}",
          subject: "How's it going, {{trigger.data.name}}?",
          body: "<p>Hi {{trigger.data.name}},</p><p>Just checking in to see how you're settling in. Need any help getting started?</p><p>Don't hesitate to reach out if you have questions!</p><p>Best,<br/>The Team</p>",
          isHtml: true,
        },
      },
      {
        id: "s5",
        type: "update_record",
        name: "Mark Onboarding Complete",
        description: "Updates the contact record to mark onboarding as done",
        config: {
          entityType: "contact",
          recordId: "{{trigger.data.id}}",
          fields: [{ field: "onboardingStatus", value: "completed" }],
        },
      },
    ],
  },
  {
    id: "lead-scoring",
    name: "Lead Scoring",
    description: "Automatically score and qualify leads",
    longDescription: "When a lead is created or updated, automatically calculate a lead score based on their data. Query related activities, apply scoring logic, and update the lead record with the calculated score.",
    icon: Target,
    category: "automation",
    steps: 4,
    color: "violet",
    requiredObjects: ["Lead", "Contact"],
    requiredIntegrations: [],
    trigger: { type: "entity_event", entityType: "contact", eventType: "updated" },
    workflowSteps: [
      {
        id: "s1",
        type: "query_data",
        name: "Get Lead Activities",
        description: "Queries the lead's activity history for scoring",
        config: { entityType: "contact", filters: [] },
      },
      {
        id: "s2",
        type: "set_variable",
        name: "Calculate Score",
        description: "Computes the lead score based on activity count",
        config: { name: "leadScore", value: "{{steps.s1.count}}" },
      },
      {
        id: "s3",
        type: "update_record",
        name: "Update Lead Score",
        description: "Saves the calculated score to the lead record",
        config: {
          entityType: "contact",
          recordId: "{{trigger.data.id}}",
          fields: [{ field: "score", value: "{{variables.leadScore}}" }],
        },
      },
      {
        id: "s4",
        type: "condition",
        name: "High Score?",
        description: "Checks if the lead qualifies as a high-value prospect",
        config: { field: "{{variables.leadScore}}", operator: "greater_than", value: "80" },
      },
    ],
  },
  {
    id: "task-auto-assignment",
    name: "Task Auto-Assignment",
    description: "Automatically assign tasks based on rules",
    longDescription: "When a new task or ticket is created, automatically evaluate assignment rules and assign it to the appropriate team member. Send notifications to the assignee.",
    icon: ListTodo,
    category: "automation",
    steps: 3,
    color: "indigo",
    requiredObjects: ["Task"],
    requiredIntegrations: [],
    trigger: { type: "entity_event", entityType: "ticket", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "condition",
        name: "Check Priority",
        description: "Evaluates the ticket priority level",
        config: { field: "{{trigger.data.priority}}", operator: "equals", value: "high" },
      },
      {
        id: "s2",
        type: "update_record",
        name: "Assign Task",
        description: "Assigns the ticket to a senior agent and updates the status",
        parentBranchId: "s1_if",
        config: {
          entityType: "ticket",
          recordId: "{{trigger.data.id}}",
          fields: [
            { field: "assignee", value: "senior-agent" },
            { field: "status", value: "assigned" },
          ],
        },
      },
      {
        id: "s3",
        type: "send_notification",
        name: "Notify Assignee",
        description: "Notifies the assigned agent about the new task",
        parentBranchId: "s1_if",
        config: {
          title: "New Task Assigned",
          message: "You have been assigned a new task: {{trigger.data.title}}",
          recipients: [],
        },
      },
    ],
  },
  {
    id: "follow-up-sequence",
    name: "Follow-up Sequence",
    description: "Automated multi-step email follow-up",
    longDescription: "Create an automated email drip sequence with timed delays between each message. Perfect for nurture campaigns, onboarding sequences, or follow-up reminders.",
    icon: Forward,
    category: "automation",
    steps: 5,
    color: "blue",
    requiredObjects: ["Contact"],
    requiredIntegrations: ["Email"],
    trigger: { type: "entity_event", entityType: "contact", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "send_email",
        name: "Email 1: Introduction",
        description: "Sends the initial introduction email to the new contact",
        config: {
          to: "{{trigger.data.email}}",
          subject: "Nice to meet you, {{trigger.data.name}}!",
          body: "<p>Hi {{trigger.data.name}},</p><p>Thanks for your interest! I'd love to learn more about your needs.</p><p>Best regards</p>",
          isHtml: true,
        },
      },
      {
        id: "s2",
        type: "delay",
        name: "Wait 2 Days",
        description: "Waits 2 days before sending the next email",
        config: { duration: 2, unit: "days" },
      },
      {
        id: "s3",
        type: "send_email",
        name: "Email 2: Value Proposition",
        description: "Sends a follow-up highlighting key benefits",
        config: {
          to: "{{trigger.data.email}}",
          subject: "Here's how we can help",
          body: "<p>Hi {{trigger.data.name}},</p><p>I wanted to share some ways we can help you achieve your goals.</p><p>Would you like to schedule a quick call?</p>",
          isHtml: true,
        },
      },
      {
        id: "s4",
        type: "delay",
        name: "Wait 3 Days",
        description: "Waits 3 more days before the final follow-up",
        config: { duration: 3, unit: "days" },
      },
      {
        id: "s5",
        type: "send_email",
        name: "Email 3: Final Follow-up",
        description: "Sends a gentle final check-in message",
        config: {
          to: "{{trigger.data.email}}",
          subject: "Just checking in",
          body: "<p>Hi {{trigger.data.name}},</p><p>I don't want to bother you, but wanted to check if there's anything I can help with.</p><p>Feel free to reach out anytime!</p>",
          isHtml: true,
        },
      },
    ],
  },
  {
    id: "order-processing",
    name: "Order Processing",
    description: "Automate new order processing workflow",
    longDescription: "When a new order comes in, automatically validate it, update its status, notify the fulfillment team, and send a confirmation to the customer.",
    icon: ShoppingCart,
    category: "automation",
    steps: 4,
    color: "green",
    requiredObjects: ["Order"],
    requiredIntegrations: ["Email"],
    trigger: { type: "entity_event", entityType: "order", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "log_message",
        name: "Log New Order",
        description: "Logs the new order details for tracking",
        config: { message: "New order received: {{trigger.data.id}} - Total: {{trigger.data.total}}", level: "info" },
      },
      {
        id: "s2",
        type: "update_record",
        name: "Set Processing Status",
        description: "Updates the order status to processing",
        config: {
          entityType: "order",
          recordId: "{{trigger.data.id}}",
          fields: [{ field: "status", value: "processing" }],
        },
      },
      {
        id: "s3",
        type: "send_notification",
        name: "Notify Fulfillment Team",
        description: "Alerts the fulfillment team about the new order",
        config: {
          title: "New Order to Process",
          message: "Order #{{trigger.data.id}} ({{trigger.data.total}}) needs to be fulfilled.",
          recipients: [],
        },
      },
      {
        id: "s4",
        type: "send_email",
        name: "Customer Confirmation",
        description: "Sends an order confirmation email to the customer",
        config: {
          to: "{{trigger.data.customerEmail}}",
          subject: "Order Confirmation #{{trigger.data.id}}",
          body: "<p>Thank you for your order!</p><p>Order #{{trigger.data.id}} has been received and is being processed.</p><p>We'll keep you updated on the progress.</p>",
          isHtml: true,
        },
      },
    ],
  },

  // ============================================================================
  // SCHEDULING
  // ============================================================================
  {
    id: "scheduled-report",
    name: "Scheduled Report",
    description: "Generate and send reports on schedule",
    longDescription: "Automatically generate and distribute reports on a recurring schedule. Query data from your modules, format it, and send it via email to stakeholders.",
    icon: FileText,
    category: "scheduling",
    steps: 3,
    color: "indigo",
    requiredObjects: ["Report Data"],
    requiredIntegrations: ["Email"],
    trigger: { type: "schedule", scheduleType: "recurring", cronExpression: "0 9 * * 1", timezone: "Europe/Amsterdam" },
    workflowSteps: [
      {
        id: "s1",
        type: "query_data",
        name: "Gather Report Data",
        description: "Queries the data needed for the weekly report",
        config: { entityType: "order", filters: [] },
      },
      {
        id: "s2",
        type: "transform_data",
        name: "Format Report",
        description: "Transforms the raw data into a report format",
        config: {
          mappings: [
            { source: "{{steps.s1.count}}", target: "totalRecords" },
            { source: "{{steps.s1.data}}", target: "reportData" },
          ],
        },
      },
      {
        id: "s3",
        type: "send_email",
        name: "Email Report",
        description: "Sends the formatted report to the team via email",
        config: {
          to: "team@company.com",
          subject: "Weekly Report - {{date}}",
          body: "<h2>Weekly Report</h2><p>Total records: {{steps.s2.totalRecords}}</p><p>See attached data for details.</p>",
          isHtml: true,
        },
      },
    ],
  },
  {
    id: "reminder-workflow",
    name: "Reminder",
    description: "Send timed reminders for deadlines",
    longDescription: "Never miss a deadline with automated reminders. Send notifications and emails on a recurring schedule to remind team members about upcoming tasks and deadlines.",
    icon: Clock,
    category: "scheduling",
    steps: 2,
    color: "orange",
    requiredObjects: ["Task"],
    requiredIntegrations: ["Email"],
    trigger: { type: "schedule", scheduleType: "recurring", cronExpression: "0 9 * * 1-5", timezone: "Europe/Amsterdam" },
    workflowSteps: [
      {
        id: "s1",
        type: "send_notification",
        name: "Send Reminder Notification",
        description: "Sends an in-app notification to check pending tasks",
        config: {
          title: "Daily Reminder",
          message: "Don't forget to check your pending tasks and upcoming deadlines for today!",
          recipients: [],
        },
      },
      {
        id: "s2",
        type: "send_email",
        name: "Email Reminder",
        description: "Sends a daily reminder email to the team",
        config: {
          to: "team@company.com",
          subject: "Daily Task Reminder",
          body: "<p>Good morning!</p><p>This is your daily reminder to review your pending tasks and upcoming deadlines.</p><p>Have a productive day!</p>",
          isHtml: true,
        },
      },
    ],
  },
  {
    id: "daily-digest",
    name: "Daily Digest",
    description: "Aggregate daily activity into a summary email",
    longDescription: "Compile a daily summary of all important activities and metrics. Query multiple data sources, transform into a digest format, and deliver to stakeholders every morning.",
    icon: BarChart3,
    category: "scheduling",
    steps: 3,
    color: "purple",
    requiredObjects: ["Activity Data"],
    requiredIntegrations: ["Email"],
    trigger: { type: "schedule", scheduleType: "recurring", cronExpression: "0 8 * * 1-5", timezone: "Europe/Amsterdam" },
    workflowSteps: [
      {
        id: "s1",
        type: "query_data",
        name: "Gather Daily Activities",
        description: "Queries all activities from the previous day",
        config: { entityType: "order", filters: [] },
      },
      {
        id: "s2",
        type: "transform_data",
        name: "Build Digest",
        description: "Formats the activities into a digest summary",
        config: {
          mappings: [
            { source: "{{steps.s1.count}}", target: "activityCount" },
            { source: "{{steps.s1.data}}", target: "activities" },
          ],
        },
      },
      {
        id: "s3",
        type: "send_email",
        name: "Send Digest",
        description: "Emails the daily digest to the team",
        config: {
          to: "team@company.com",
          subject: "Daily Digest - {{date}}",
          body: "<h2>Daily Activity Digest</h2><p><strong>{{steps.s2.activityCount}}</strong> activities recorded yesterday.</p><p>Check the dashboard for full details.</p>",
          isHtml: true,
        },
      },
    ],
  },
  {
    id: "scheduled-maintenance",
    name: "Scheduled Maintenance",
    description: "Run automated maintenance tasks on a schedule",
    longDescription: "Automate routine maintenance operations like data archival, cache clearing, or system health checks. Runs on a configurable schedule and logs all operations.",
    icon: HardDrive,
    category: "scheduling",
    steps: 3,
    color: "gray",
    requiredObjects: [],
    requiredIntegrations: [],
    trigger: { type: "schedule", scheduleType: "recurring", cronExpression: "0 3 * * 0", timezone: "Europe/Amsterdam" },
    workflowSteps: [
      {
        id: "s1",
        type: "log_message",
        name: "Start Maintenance",
        description: "Logs the start of the maintenance window",
        config: { message: "Starting scheduled maintenance run...", level: "info" },
      },
      {
        id: "s2",
        type: "http_request",
        name: "Run Maintenance Task",
        description: "Calls the maintenance API to run cleanup tasks",
        config: {
          method: "POST",
          url: "https://api.example.com/maintenance/run",
          headers: [{ key: "Authorization", value: "Bearer YOUR_API_KEY" }],
          body: '{"task": "cleanup", "dryRun": false}',
          timeout: 60000,
        },
      },
      {
        id: "s3",
        type: "log_message",
        name: "Log Completion",
        description: "Logs the maintenance result and completion status",
        config: { message: "Scheduled maintenance completed. Result: {{steps.s2.response}}", level: "info" },
      },
    ],
  },

  // ============================================================================
  // INTEGRATIONS
  // ============================================================================
  {
    id: "webhook-handler",
    name: "Webhook Handler",
    description: "Process incoming webhooks from external services",
    longDescription: "Receive and process webhooks from external services. Log the incoming payload, validate it with conditional logic, and forward the data via an HTTP request to another service.",
    icon: Webhook,
    category: "integrations",
    steps: 3,
    color: "pink",
    requiredObjects: [],
    requiredIntegrations: [],
    trigger: { type: "webhook" },
    workflowSteps: [
      {
        id: "s1",
        type: "log_message",
        name: "Log Webhook Payload",
        description: "Logs the incoming webhook data for debugging",
        config: { message: "Webhook received: {{trigger.data}}", level: "info" },
      },
      {
        id: "s2",
        type: "condition",
        name: "Validate Payload",
        description: "Checks that the webhook payload contains required data",
        config: { field: "{{trigger.data.type}}", operator: "not_equals", value: "" },
      },
      {
        id: "s3",
        type: "http_request",
        name: "Forward to Service",
        description: "Forwards the validated payload to the downstream service",
        parentBranchId: "s2_if",
        config: {
          method: "POST",
          url: "https://api.example.com/webhook/process",
          headers: [{ key: "Content-Type", value: "application/json" }],
          body: "{{trigger.data}}",
          timeout: 10000,
        },
      },
    ],
  },
  {
    id: "api-integration",
    name: "API Integration",
    description: "Connect and sync data with external APIs",
    longDescription: "Build integrations with external APIs when entity events occur. Make HTTP requests, transform response data, and create or update records in your system.",
    icon: Globe,
    category: "integrations",
    steps: 4,
    color: "violet",
    requiredObjects: ["Record"],
    requiredIntegrations: ["REST API"],
    trigger: { type: "entity_event", entityType: "contact", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "http_request",
        name: "Call External API",
        description: "Sends the new record data to the external API",
        config: {
          method: "POST",
          url: "https://api.example.com/contacts",
          headers: [
            { key: "Content-Type", value: "application/json" },
            { key: "Authorization", value: "Bearer YOUR_API_KEY" },
          ],
          body: '{"name": "{{trigger.data.name}}", "email": "{{trigger.data.email}}"}',
          timeout: 10000,
        },
      },
      {
        id: "s2",
        type: "transform_data",
        name: "Transform Response",
        description: "Maps the API response fields to local field names",
        config: {
          mappings: [
            { source: "{{steps.s1.response.externalId}}", target: "externalId" },
            { source: "{{steps.s1.response.status}}", target: "syncStatus" },
          ],
        },
      },
      {
        id: "s3",
        type: "update_record",
        name: "Store External ID",
        description: "Saves the external system ID on the local record",
        config: {
          entityType: "contact",
          recordId: "{{trigger.data.id}}",
          fields: [{ field: "externalId", value: "{{steps.s2.externalId}}" }],
        },
      },
      {
        id: "s4",
        type: "log_message",
        name: "Log Integration",
        description: "Logs the integration result for audit purposes",
        config: { message: "API integration completed for {{trigger.data.id}}. External ID: {{steps.s2.externalId}}", level: "info" },
      },
    ],
  },
  {
    id: "webhook-relay",
    name: "Webhook Relay",
    description: "Receive webhooks and forward to multiple services",
    longDescription: "Set up a webhook relay that receives incoming webhooks, transforms the payload, and forwards it to multiple downstream services. Includes logging for audit trails.",
    icon: ArrowRight,
    category: "integrations",
    steps: 4,
    color: "cyan",
    requiredObjects: [],
    requiredIntegrations: ["REST API"],
    trigger: { type: "webhook" },
    workflowSteps: [
      {
        id: "s1",
        type: "log_message",
        name: "Log Incoming Webhook",
        description: "Logs the incoming webhook for audit tracking",
        config: { message: "Relay received webhook: {{trigger.data}}", level: "info" },
      },
      {
        id: "s2",
        type: "transform_data",
        name: "Transform Payload",
        description: "Prepares the payload for downstream services",
        config: {
          mappings: [
            { source: "{{trigger.data}}", target: "payload" },
          ],
        },
      },
      {
        id: "s3",
        type: "http_request",
        name: "Forward to Service A",
        description: "Sends the payload to the first downstream service",
        config: {
          method: "POST",
          url: "https://service-a.example.com/webhook",
          headers: [{ key: "Content-Type", value: "application/json" }],
          body: "{{steps.s2.payload}}",
          timeout: 10000,
        },
      },
      {
        id: "s4",
        type: "http_request",
        name: "Forward to Service B",
        description: "Sends the payload to the second downstream service",
        config: {
          method: "POST",
          url: "https://service-b.example.com/webhook",
          headers: [{ key: "Content-Type", value: "application/json" }],
          body: "{{steps.s2.payload}}",
          timeout: 10000,
        },
      },
    ],
  },
  {
    id: "crm-external-sync",
    name: "CRM External Sync",
    description: "Sync CRM data with an external CRM system",
    longDescription: "Keep your CRM data in sync with external CRM systems like Salesforce or HubSpot. Periodically fetch data, compare records, and update your local CRM with changes.",
    icon: RefreshCw,
    category: "integrations",
    steps: 4,
    color: "emerald",
    requiredObjects: ["Contact"],
    requiredIntegrations: ["REST API"],
    trigger: { type: "schedule", scheduleType: "recurring", cronExpression: "0 */2 * * *", timezone: "Europe/Amsterdam" },
    workflowSteps: [
      {
        id: "s1",
        type: "http_request",
        name: "Fetch External CRM Data",
        description: "Fetches recently updated contacts from the external CRM",
        config: {
          method: "GET",
          url: "https://api.external-crm.com/contacts?updated_since=2h",
          headers: [{ key: "Authorization", value: "Bearer YOUR_API_KEY" }],
          timeout: 30000,
        },
      },
      {
        id: "s2",
        type: "transform_data",
        name: "Map CRM Fields",
        description: "Maps external CRM fields to the local contact format",
        config: {
          mappings: [
            { source: "{{steps.s1.response.contacts}}", target: "contacts" },
          ],
        },
      },
      {
        id: "s3",
        type: "loop",
        name: "Process Each Contact",
        description: "Loops through each contact to sync changes",
        config: { source: "{{steps.s2.contacts}}", variable: "contact" },
      },
      {
        id: "s4",
        type: "log_message",
        name: "Log Sync Result",
        description: "Logs a summary of the CRM sync operation",
        config: { message: "CRM sync completed. Processed {{steps.s1.response.total}} contacts.", level: "info" },
      },
    ],
  },

  // ============================================================================
  // AI
  // ============================================================================
  {
    id: "ai-content-generator",
    name: "AI Content Generator",
    description: "Generate content with AI on demand",
    longDescription: "Manually trigger AI-powered content generation. Provide a topic or prompt and let AI generate marketing copy, blog posts, social media content, or email templates.",
    icon: Sparkles,
    category: "ai",
    steps: 3,
    color: "violet",
    requiredObjects: [],
    requiredIntegrations: ["OpenAI"],
    trigger: { type: "manual" },
    workflowSteps: [
      {
        id: "s1",
        type: "ai_generate",
        name: "Generate Content",
        description: "Uses AI to generate professional content based on the topic",
        config: {
          prompt: "Generate a professional email about {{trigger.data.topic}}. Keep it concise and engaging.",
          model: "gpt-4",
          maxTokens: 500,
        },
      },
      {
        id: "s2",
        type: "log_message",
        name: "Log Generated Content",
        description: "Logs the content generation for tracking",
        config: { message: "AI content generated successfully.", level: "info" },
      },
      {
        id: "s3",
        type: "send_email",
        name: "Send Generated Content",
        description: "Emails the generated content to the recipient",
        config: {
          to: "{{trigger.data.recipientEmail}}",
          subject: "Generated Content: {{trigger.data.topic}}",
          body: "{{steps.s1.result}}",
          isHtml: false,
        },
      },
    ],
  },
  {
    id: "ai-data-extractor",
    name: "AI Data Extractor",
    description: "Extract structured data from text using AI",
    longDescription: "When new unstructured data arrives (emails, documents, notes), use AI to extract structured information like names, dates, amounts, and categories. Automatically update records with the extracted data.",
    icon: FileSearch,
    category: "ai",
    steps: 3,
    color: "blue",
    requiredObjects: ["Record"],
    requiredIntegrations: ["OpenAI"],
    trigger: { type: "entity_event", entityType: "contact", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "ai_extract",
        name: "Extract Data from Text",
        description: "Uses AI to extract structured fields from unstructured text",
        config: {
          source: "{{trigger.data.notes}}",
          fields: ["company", "phone", "address", "industry"],
        },
      },
      {
        id: "s2",
        type: "update_record",
        name: "Update with Extracted Data",
        description: "Saves the extracted data to the contact record",
        config: {
          entityType: "contact",
          recordId: "{{trigger.data.id}}",
          fields: [
            { field: "company", value: "{{steps.s1.company}}" },
            { field: "phone", value: "{{steps.s1.phone}}" },
          ],
        },
      },
      {
        id: "s3",
        type: "log_message",
        name: "Log Extraction",
        description: "Logs the extraction result for verification",
        config: { message: "AI data extraction completed for record {{trigger.data.id}}.", level: "info" },
      },
    ],
  },
  {
    id: "ai-ticket-classifier",
    name: "AI Ticket Classifier",
    description: "Classify support tickets with AI",
    longDescription: "Automatically classify incoming support tickets using AI. Analyze the ticket content, determine the category and priority, then update the ticket and route it to the appropriate team.",
    icon: Brain,
    category: "ai",
    steps: 4,
    color: "purple",
    requiredObjects: ["Ticket"],
    requiredIntegrations: ["OpenAI"],
    trigger: { type: "entity_event", entityType: "ticket", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "ai_extract",
        name: "Classify Ticket",
        description: "Uses AI to determine the ticket category, priority, and sentiment",
        config: {
          source: "{{trigger.data.subject}} {{trigger.data.body}}",
          fields: ["category", "priority", "sentiment"],
        },
      },
      {
        id: "s2",
        type: "update_record",
        name: "Update Ticket Classification",
        description: "Saves the AI classification to the ticket record",
        config: {
          entityType: "ticket",
          recordId: "{{trigger.data.id}}",
          fields: [
            { field: "category", value: "{{steps.s1.category}}" },
            { field: "priority", value: "{{steps.s1.priority}}" },
          ],
        },
      },
      {
        id: "s3",
        type: "condition",
        name: "Is Urgent?",
        description: "Checks if the AI classified the ticket as urgent",
        config: { field: "{{steps.s1.priority}}", operator: "equals", value: "urgent" },
      },
      {
        id: "s4",
        type: "send_notification",
        name: "Urgent Alert",
        description: "Sends an urgent notification to the team for immediate attention",
        parentBranchId: "s3_if",
        config: {
          title: "Urgent Ticket",
          message: "Ticket #{{trigger.data.id}} has been classified as urgent ({{steps.s1.category}}). Sentiment: {{steps.s1.sentiment}}",
          recipients: [],
        },
      },
    ],
  },
  {
    id: "ai-email-responder",
    name: "AI Email Responder",
    description: "Auto-draft email responses using AI",
    longDescription: "When a new support email or inquiry arrives, use AI to generate a professional draft response based on the content. Review and send, or automatically send for common queries.",
    icon: Bot,
    category: "ai",
    steps: 4,
    color: "teal",
    requiredObjects: ["Email"],
    requiredIntegrations: ["OpenAI", "Email"],
    trigger: { type: "entity_event", entityType: "ticket", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "ai_generate",
        name: "Generate Response",
        description: "Uses AI to draft a professional response to the customer inquiry",
        config: {
          prompt: "Write a professional, helpful response to this customer inquiry:\n\nSubject: {{trigger.data.subject}}\nMessage: {{trigger.data.body}}\n\nBe polite, concise, and address their concern directly.",
          model: "gpt-4",
          maxTokens: 400,
        },
      },
      {
        id: "s2",
        type: "log_message",
        name: "Log AI Response",
        description: "Logs the generated response for review",
        config: { message: "AI response generated for ticket {{trigger.data.id}}", level: "info" },
      },
      {
        id: "s3",
        type: "send_email",
        name: "Send Response",
        description: "Sends the AI-generated response to the customer",
        config: {
          to: "{{trigger.data.customerEmail}}",
          subject: "Re: {{trigger.data.subject}}",
          body: "{{steps.s1.result}}",
          isHtml: false,
        },
      },
      {
        id: "s4",
        type: "update_record",
        name: "Mark as Responded",
        description: "Updates the ticket status to responded",
        config: {
          entityType: "ticket",
          recordId: "{{trigger.data.id}}",
          fields: [{ field: "status", value: "responded" }],
        },
      },
    ],
  },

  // ============================================================================
  // COMMUNICATION
  // ============================================================================
  {
    id: "order-confirmation",
    name: "Order Confirmation",
    description: "Send confirmation emails for new orders",
    longDescription: "Automatically send a beautifully formatted order confirmation email when a new order is placed. Update the order status and log the confirmation.",
    icon: ShoppingCart,
    category: "communication",
    steps: 3,
    color: "green",
    requiredObjects: ["Order"],
    requiredIntegrations: ["Email"],
    trigger: { type: "entity_event", entityType: "order", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "send_email",
        name: "Send Confirmation",
        description: "Sends a formatted order confirmation email to the customer",
        config: {
          to: "{{trigger.data.customerEmail}}",
          subject: "Order Confirmed! #{{trigger.data.orderNumber}}",
          body: "<h2>Thank you for your order!</h2><p>Your order <strong>#{{trigger.data.orderNumber}}</strong> has been confirmed.</p><p>Order total: <strong>{{trigger.data.total}}</strong></p><p>We'll notify you when it ships.</p>",
          isHtml: true,
        },
      },
      {
        id: "s2",
        type: "update_record",
        name: "Update Order Status",
        description: "Marks the order as confirmed with a timestamp",
        config: {
          entityType: "order",
          recordId: "{{trigger.data.id}}",
          fields: [
            { field: "status", value: "confirmed" },
            { field: "confirmedAt", value: "{{now}}" },
          ],
        },
      },
      {
        id: "s3",
        type: "log_message",
        name: "Log Confirmation",
        description: "Logs the confirmation for audit tracking",
        config: { message: "Order confirmation sent for #{{trigger.data.orderNumber}} to {{trigger.data.customerEmail}}", level: "info" },
      },
    ],
  },
  {
    id: "customer-welcome",
    name: "Customer Welcome Series",
    description: "Welcome new customers with a series of emails",
    longDescription: "Create a warm welcome experience for new customers. Send an immediate welcome email, wait a few days, then follow up with helpful tips and resources to get them started.",
    icon: Users,
    category: "communication",
    steps: 4,
    color: "teal",
    requiredObjects: ["Contact"],
    requiredIntegrations: ["Email"],
    trigger: { type: "entity_event", entityType: "contact", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "send_email",
        name: "Welcome Email",
        description: "Sends an immediate welcome email to the new customer",
        config: {
          to: "{{trigger.data.email}}",
          subject: "Welcome to the family, {{trigger.data.name}}!",
          body: "<p>Hi {{trigger.data.name}},</p><p>We're delighted to welcome you! Here's what you can expect from us:</p><ul><li>Quality products and services</li><li>Responsive customer support</li><li>Regular updates and offers</li></ul><p>Welcome aboard!</p>",
          isHtml: true,
        },
      },
      {
        id: "s2",
        type: "delay",
        name: "Wait 5 Days",
        description: "Waits 5 days before sending helpful tips",
        config: { duration: 5, unit: "days" },
      },
      {
        id: "s3",
        type: "send_email",
        name: "Tips & Resources Email",
        description: "Sends an email with tips to get the most out of the platform",
        config: {
          to: "{{trigger.data.email}}",
          subject: "Getting the most out of your account",
          body: "<p>Hi {{trigger.data.name}},</p><p>Here are some tips to help you get the most out of your experience:</p><ol><li>Complete your profile</li><li>Explore our product catalog</li><li>Set up notifications</li></ol><p>Questions? Just reply to this email!</p>",
          isHtml: true,
        },
      },
      {
        id: "s4",
        type: "log_message",
        name: "Log Welcome Sequence",
        description: "Logs that the welcome series has completed",
        config: { message: "Welcome series completed for {{trigger.data.email}}", level: "info" },
      },
    ],
  },
  {
    id: "ticket-auto-reply",
    name: "Ticket Auto-Reply",
    description: "Auto-reply to new support tickets",
    longDescription: "Instantly acknowledge new support tickets with a professional auto-reply. Always sends an acknowledgement email, then checks priority to escalate high-priority tickets to the team.",
    icon: MessageSquare,
    category: "communication",
    steps: 4,
    color: "pink",
    requiredObjects: ["Ticket"],
    requiredIntegrations: ["Email"],
    trigger: { type: "entity_event", entityType: "ticket", eventType: "created" },
    workflowSteps: [
      {
        id: "s1",
        type: "send_email",
        name: "Send Auto-Reply",
        description: "Sends an immediate acknowledgement email to the customer",
        config: {
          to: "{{trigger.data.customerEmail}}",
          subject: "Re: {{trigger.data.subject}} - We got your message!",
          body: "<p>Hi,</p><p>Thank you for reaching out! We've received your support request and a team member will get back to you shortly.</p><p><strong>Ticket ID:</strong> #{{trigger.data.id}}</p><p>In the meantime, you can check our help center for quick answers.</p><p>Best,<br/>Support Team</p>",
          isHtml: true,
        },
      },
      {
        id: "s2",
        type: "update_record",
        name: "Mark as Acknowledged",
        description: "Updates the ticket to record the auto-reply was sent",
        config: {
          entityType: "ticket",
          recordId: "{{trigger.data.id}}",
          fields: [{ field: "autoReplied", value: "true" }],
        },
      },
      {
        id: "s3",
        type: "condition",
        name: "Is High Priority?",
        description: "Checks if the ticket is marked as high priority",
        config: { field: "{{trigger.data.priority}}", operator: "equals", value: "high" },
      },
      {
        id: "s4",
        type: "send_notification",
        name: "Escalate to Team",
        description: "Sends an urgent notification to escalate the high-priority ticket",
        parentBranchId: "s3_if",
        config: {
          title: "High Priority Ticket",
          message: "Ticket #{{trigger.data.id}} is high priority and needs immediate attention: {{trigger.data.subject}}",
          recipients: [],
        },
      },
    ],
  },
];

// Maps a template's static `id` to its translation key under
// `t.weldconnect.templateCatalog.items`. Keep in sync with `builtInTemplates`.
const TEMPLATE_TRANSLATION_KEYS: Record<string, string> = {
  'email-notification': 'emailNotification',
  'threshold-alert': 'thresholdAlert',
  'sla-breach-alert': 'slaBreachAlert',
  'low-stock-alert': 'lowStockAlert',
  'error-webhook-alert': 'errorWebhookAlert',
  'record-sync': 'recordSync',
  'data-cleanup': 'dataCleanup',
  'data-enrichment': 'dataEnrichment',
  'periodic-import': 'periodicImport',
  'entity-automation': 'entityAutomation',
  'approval-workflow': 'approvalWorkflow',
  'user-onboarding': 'userOnboarding',
  'lead-scoring': 'leadScoring',
  'task-auto-assignment': 'taskAutoAssignment',
  'follow-up-sequence': 'followUpSequence',
  'order-processing': 'orderProcessing',
  'scheduled-report': 'scheduledReport',
  'reminder-workflow': 'reminderWorkflow',
  'daily-digest': 'dailyDigest',
  'scheduled-maintenance': 'scheduledMaintenance',
  'webhook-handler': 'webhookHandler',
  'api-integration': 'apiIntegration',
  'webhook-relay': 'webhookRelay',
  'crm-external-sync': 'crmExternalSync',
  'ai-content-generator': 'aiContentGenerator',
  'ai-data-extractor': 'aiDataExtractor',
  'ai-ticket-classifier': 'aiTicketClassifier',
  'ai-email-responder': 'aiEmailResponder',
  'order-confirmation': 'orderConfirmation',
  'customer-welcome': 'customerWelcome',
  'ticket-auto-reply': 'ticketAutoReply',
};

// Maps a category's static `id` to its translation key under
// `t.weldconnect.templateCatalog.categories`.
const CATEGORY_TRANSLATION_KEYS: Record<string, string> = {
  all: 'all',
  notifications: 'notifications',
  'data-sync': 'dataSync',
  automation: 'automation',
  scheduling: 'scheduling',
  integrations: 'integrations',
  ai: 'ai',
  communication: 'communication',
};

interface LocalizedCategory {
  id: string;
  label: string;
  icon: React.ElementType;
}

/** `builtInTemplates` with name/description/longDescription resolved from i18n. */
export function useLocalizedTemplates(): WorkflowTemplate[] {
  const { t } = useI18n();
  return useMemo(() => {
    const items = t.weldconnect.templateCatalog.items as Record<string, { name: string; description: string; longDescription?: string }>;
    return builtInTemplates.map((template) => {
      const key = TEMPLATE_TRANSLATION_KEYS[template.id];
      const translated = key ? items[key] : undefined;
      if (!translated) return template;
      return {
        ...template,
        name: translated.name,
        description: translated.description,
        longDescription: translated.longDescription ?? template.longDescription,
      };
    });
  }, [t]);
}

/** `CATEGORIES` with labels resolved from i18n. */
export function useLocalizedCategories(): LocalizedCategory[] {
  const { t } = useI18n();
  return useMemo(() => {
    const labels = t.weldconnect.templateCatalog.categories as Record<string, string>;
    return CATEGORIES.map((category) => {
      const key = CATEGORY_TRANSLATION_KEYS[category.id];
      return { ...category, label: key ? labels[key] : category.label };
    });
  }, [t]);
}

// Mini workflow preview component
export function WorkflowPreview({ workflowSteps, triggerType }: { workflowSteps: TemplateStep[]; triggerType: string }) {
  const displaySteps = workflowSteps.slice(0, 4);
  const remaining = workflowSteps.length - 4;
  const TriggerIcon = triggerIcons[triggerType] || Zap;

  return (
    <div className="flex items-center justify-center gap-1.5 py-2">
      {/* Trigger node */}
      <div className="w-7 h-7 rounded-md bg-amber-100 flex items-center justify-center">
        <TriggerIcon className="w-3.5 h-3.5 text-amber-600" />
      </div>

      {displaySteps.map((step) => {
        const StepIcon = stepActionIcons[step.type] || FileText;
        const iconColor = stepIconColors[step.type] || { bg: "bg-gray-100", text: "text-gray-600" };
        return (
          <React.Fragment key={step.id}>
            <div className="w-3 h-0.5 rounded-full bg-border" />
            <div className={cn("w-7 h-7 rounded-md flex items-center justify-center", iconColor.bg)}>
              <StepIcon className={cn("w-3.5 h-3.5", iconColor.text)} />
            </div>
          </React.Fragment>
        );
      })}

      {remaining > 0 && (
        <>
          <div className="w-3 h-0.5 rounded-full bg-border" />
          <span className="text-[10px] text-muted-foreground">+{remaining}</span>
        </>
      )}
    </div>
  );
}

// Node types for the preview canvas (same as the real editor)
const previewNodeTypes = {
  trigger: TriggerNode,
  action: ActionNode,
  condition: ConditionNode,
  condition_branch: ConditionBranchNode,
  placeholder: PlaceholderNode,
};

// Convert template data to TriggerConfig and WorkflowStep[] for the flow renderer
function templateToFlowData(template: WorkflowTemplate): { trigger: TriggerConfig; steps: WorkflowStep[] } {
  const trigger: TriggerConfig = {
    id: `preview-trigger`,
    type: template.trigger.type as TriggerConfig['type'],
    name: 'Trigger',
    isEnabled: true,
    config: {
      type: template.trigger.type,
      ...(template.trigger.type === 'entity_event' ? {
        entityType: template.trigger.entityType || 'entity',
        eventType: template.trigger.eventType || 'created',
      } : {}),
      ...(template.trigger.type === 'schedule' ? {
        cronExpression: template.trigger.cronExpression || '0 9 * * *',
        timezone: template.trigger.timezone || 'Europe/Amsterdam',
      } : {}),
      ...(template.trigger.type === 'webhook' ? {
        method: 'POST' as const,
      } : {}),
      ...(template.trigger.type === 'manual' ? {} : {}),
      ...(template.trigger.type === 'workflow_complete' ? {
        sourceWorkflowId: '',
        triggerOn: 'success' as const,
      } : {}),
    } as TriggerConfig['config'],
  };

  const steps: WorkflowStep[] = template.workflowSteps.map((step, i) => ({
    id: step.id,
    type: step.type,
    name: step.name,
    description: step.description,
    config: step.config as Record<string, unknown>,
    inputs: {},
    ...(step.parentBranchId ? { parentBranchId: step.parentBranchId } : {}),
  }));

  return { trigger, steps };
}

// Preview controls (must be inside ReactFlow to use useReactFlow)
function PreviewControls() {
  const t = useTranslations();
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  // Handle keyboard shortcuts for zoom
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          zoomIn({ duration: 150 });
        } else if (e.key === '-') {
          e.preventDefault();
          zoomOut({ duration: 150 });
        } else if (e.key === '0') {
          e.preventDefault();
          fitView({ padding: 0.15, duration: 200 });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [zoomIn, zoomOut, fitView]);

  return (
    <Panel position="bottom-right" className="!m-3">
      <div className="flex flex-col bg-white border border-border rounded-lg overflow-hidden">
        <Button
          variant="ghost"
          onClick={() => zoomIn({ duration: 150 })}
          className="w-8 h-8 flex items-center justify-center hover:bg-muted transition-colors p-0 rounded-none"
          title={t('sweep.weldconnect.templatePreview.zoomIn')}
        >
          <Plus className="w-3.5 h-3.5 text-foreground" />
        </Button>
        <div className="border-t border-border" />
        <Button
          variant="ghost"
          onClick={() => zoomOut({ duration: 150 })}
          className="w-8 h-8 flex items-center justify-center hover:bg-muted transition-colors p-0 rounded-none"
          title={t('sweep.weldconnect.templatePreview.zoomOut')}
        >
          <Minus className="w-3.5 h-3.5 text-foreground" />
        </Button>
        <div className="border-t border-border" />
        <Button
          variant="ghost"
          onClick={() => fitView({ padding: 0.15, duration: 200 })}
          className="w-8 h-8 flex items-center justify-center hover:bg-muted transition-colors p-0 rounded-none"
          title={t('sweep.weldconnect.templatePreview.fitView')}
        >
          <Maximize className="w-3.5 h-3.5 text-foreground" />
        </Button>
      </div>
    </Panel>
  );
}

// Large workflow preview using the actual React Flow canvas
export function LargeWorkflowPreview({ template }: { template: WorkflowTemplate }) {
  const { trigger, steps } = useMemo(() => templateToFlowData(template), [template]);
  const { nodes: rawNodes, edges: rawEdges } = useMemo(
    () => workflowToFlow(trigger, steps),
    [trigger, steps]
  );

  const defaultNodes = useMemo(() => rawNodes.map(node => ({
    ...node,
    data: {
      ...node.data,
      onSelect: undefined,
      onDelete: undefined,
      onAddStep: undefined,
      onUpdateConfig: undefined,
      onSelectBranch: undefined,
      showAddPlaceholder: false,
      isLastNode: false,
    },
    draggable: false,
    selectable: false,
    connectable: false,
  })), [rawNodes]);

  const defaultEdges = useMemo(() => rawEdges.map(edge => ({
    ...edge,
    selectable: false,
    focusable: false,
  })), [rawEdges]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        defaultNodes={defaultNodes}
        defaultEdges={defaultEdges}
        nodeTypes={previewNodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 0.85 }}
        minZoom={0.2}
        maxZoom={1.5}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background id="template-preview" variant={BackgroundVariant.Dots} gap={20} size={1} bgColor="hsl(var(--muted) / 0.3)" />
        <PreviewControls />
      </ReactFlow>
    </div>
  );
}

export function resolveTemplateForApply(template: WorkflowTemplate): { trigger: any; steps: any[] } {
  const now = Date.now();
  const idMap = new Map<string, string>();

  const steps = template.workflowSteps.map((step, i) => {
    const newId = `step-${now}-${i}`;
    idMap.set(step.id, newId);
    return {
      id: newId,
      type: step.type,
      name: step.name,
      ...(step.description ? { description: step.description } : {}),
      config: { ...step.config },
      order: i,
      ...(step.parentBranchId ? { parentBranchId: step.parentBranchId } : {}),
    };
  });

  // Update parentBranchId references to new IDs
  steps.forEach((step) => {
    if (step.parentBranchId) {
      const baseId = step.parentBranchId.replace(/_if$|_if_not$/, '');
      const suffix = step.parentBranchId.endsWith('_if_not') ? '_if_not' : '_if';
      const newBaseId = idMap.get(baseId);
      if (newBaseId) {
        step.parentBranchId = `${newBaseId}${suffix}`;
      }
    }
  });

  const trigger = { id: `trigger-${now}`, ...template.trigger };

  return { trigger, steps };
}

interface WorkflowTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectTemplate: (template: { id: string; name: string; trigger?: any; steps?: any[] }) => void;
}

function TemplateCard({ template, onClick }: { template: WorkflowTemplate; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className="rounded-lg border border-border hover:bg-muted/50 hover:border-muted-foreground/20 transition-colors text-left overflow-hidden h-auto p-0 flex-col items-stretch"
    >
      {/* Preview */}
      <div className="h-36 bg-muted/30 border-b flex items-center justify-center">
        <WorkflowPreview workflowSteps={template.workflowSteps} triggerType={template.trigger.type} />
      </div>
      {/* Content */}
      <div className="p-3">
        <p className="text-sm font-medium truncate mb-1">{template.name}</p>
        <p className="text-xs text-muted-foreground line-clamp-2">
          {template.description}
        </p>
      </div>
    </Button>
  );
}

export function WorkflowTemplateDialog({
  open,
  onOpenChange,
  onSelectTemplate,
}: WorkflowTemplateDialogProps) {
  const { t } = useI18n();
  const templates = useLocalizedTemplates();
  const categories = useLocalizedCategories();
  const [searchQuery, setSearchQuery] = React.useState("");
  const [selectedCategory, setSelectedCategory] = React.useState("all");
  const [selectedTemplate, setSelectedTemplate] = React.useState<WorkflowTemplate | null>(null);

  const filteredTemplates = templates.filter(template => {
    const matchesSearch = searchQuery === "" ||
      template.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      template.description.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesCategory = selectedCategory === "all" || template.category === selectedCategory;

    return matchesSearch && matchesCategory;
  });

  const handleTemplateClick = (template: WorkflowTemplate) => {
    setSelectedTemplate(template);
  };

  const handleBackToList = () => {
    setSelectedTemplate(null);
  };

  const handleUseTemplate = () => {
    if (!selectedTemplate) return;
    const resolved = resolveTemplateForApply(selectedTemplate);
    onSelectTemplate({
      id: selectedTemplate.id,
      name: selectedTemplate.name,
      trigger: resolved.trigger,
      steps: resolved.steps,
    });
    onOpenChange(false);
    setSearchQuery("");
    setSelectedCategory("all");
    setSelectedTemplate(null);
  };

  const handleStartFromScratch = () => {
    onSelectTemplate({ id: "blank", name: t.weldconnect.templateCatalog.blankWorkflowName });
    onOpenChange(false);
    setSearchQuery("");
    setSelectedCategory("all");
    setSelectedTemplate(null);
  };

  const handleClose = () => {
    onOpenChange(false);
    setSelectedTemplate(null);
    setSearchQuery("");
    setSelectedCategory("all");
  };

  // Get category label for the selected template
  const getCategoryLabel = (categoryId: string) => {
    return categories.find(c => c.id === categoryId)?.label || categoryId;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="overflow-hidden p-0 !max-w-[1000px] w-[1000px] h-[700px] !gap-0" showCloseButton={false} onKeyDown={(e) => e.stopPropagation()}>
        <DialogTitle className="sr-only">{t.weldconnect.templateCatalog.dialogTitle}</DialogTitle>
        <DialogDescription className="sr-only">
          {t.weldconnect.templateCatalog.dialogDescription}
        </DialogDescription>

        {selectedTemplate ? (
          // Detail View
          <div className="flex h-full flex-col">
            {/* Header */}
            <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
              <Button
                variant="ghost"
                onClick={handleBackToList}
                className="flex items-center gap-1 text-sm text-foreground hover:bg-muted rounded-md px-2 py-1 -ml-2 transition-colors h-auto"
              >
                <ChevronLeft className="h-4 w-4" />
                <span>{t.weldconnect.components.workflowTemplate.back}</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 -mr-2"
                onClick={handleClose}
              >
                <X className="h-4 w-4" />
              </Button>
            </header>

            {/* Content */}
            <div className="flex flex-1 min-h-0">
              {/* Left - Workflow Preview */}
              <div className="flex-1 border-r overflow-hidden relative">
                <LargeWorkflowPreview template={selectedTemplate} />
              </div>

              {/* Right - Details Panel */}
              <div className="w-80 flex flex-col">
                <div className="flex-1 overflow-y-auto p-4 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20 [&::-webkit-scrollbar-thumb]:rounded-full">
                  {/* Category Badge */}
                  <Badge variant="secondary" className="mb-3 rounded-sm">
                    {getCategoryLabel(selectedTemplate.category)}
                  </Badge>

                  {/* Title */}
                  <h2 className="text-lg font-semibold mb-2">{selectedTemplate.name}</h2>

                  {/* Description */}
                  <p className="text-sm text-muted-foreground mb-6">
                    {selectedTemplate.longDescription || selectedTemplate.description}
                  </p>

                  {/* Required Objects */}
                  {selectedTemplate.requiredObjects && selectedTemplate.requiredObjects.length > 0 && (
                    <div className="mb-4">
                      <h3 className="text-sm font-medium mb-2">{t.weldconnect.components.workflowTemplate.requiredObjects}</h3>
                      <div className="flex flex-col gap-2">
                        {selectedTemplate.requiredObjects.map((obj) => (
                          <div
                            key={obj}
                            className="flex items-center gap-2 text-xs text-muted-foreground"
                          >
                            <div className="w-5 h-5 rounded-[4.5px] bg-amber-100 flex items-center justify-center">
                              <Database className="w-3 h-3 text-amber-600" />
                            </div>
                            <span>{obj}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Required Integrations */}
                  {selectedTemplate.requiredIntegrations && selectedTemplate.requiredIntegrations.length > 0 && (
                    <div className="mb-4">
                      <h3 className="text-sm font-medium mb-2">{t.weldconnect.components.workflowTemplate.requiredIntegrations}</h3>
                      <div className="flex flex-col gap-2">
                        {selectedTemplate.requiredIntegrations.map((integration) => (
                          <div
                            key={integration}
                            className="flex items-center gap-2 text-xs text-muted-foreground"
                          >
                            <div className="w-5 h-5 rounded-[4.5px] bg-blue-100 flex items-center justify-center">
                              <Plug className="w-3 h-3 text-blue-600" />
                            </div>
                            <span>{integration}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Steps Overview */}
                  <div className="mb-4">
                    <h3 className="text-sm font-medium mb-2">{t.weldconnect.components.workflowTemplate.steps}</h3>
                    <div className="flex flex-col gap-1.5">
                      {selectedTemplate.workflowSteps.map((step) => {
                        const StepIcon = stepActionIcons[step.type] || FileText;
                        const iconColor = stepIconColors[step.type] || { bg: "bg-gray-100", text: "text-gray-600" };
                        return (
                          <div
                            key={step.id}
                            className="flex items-center gap-2 text-xs text-muted-foreground"
                          >
                            <div className={cn("w-5 h-5 rounded-[4.5px] flex items-center justify-center shrink-0", iconColor.bg)}>
                              <StepIcon className={cn("w-3 h-3", iconColor.text)} />
                            </div>
                            <span className="truncate">{step.name}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Footer */}
                <div className="p-4">
                  <Button className="w-full rounded-[9px]" onClick={handleUseTemplate}>
                    {t.weldconnect.templates.useTemplate}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          // List View
          <SidebarProvider className="items-start !min-h-0 h-full">
            <Sidebar collapsible="none" className="hidden md:flex border-r h-full">
              <SidebarContent>
                <SidebarGroup>
                  <SidebarGroupLabel>{t.weldconnect.components.workflowTemplate.categories}</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {categories.map((category) => (
                        <SidebarMenuItem key={category.id}>
                          <SidebarMenuButton
                            onClick={() => setSelectedCategory(category.id)}
                            isActive={selectedCategory === category.id}
                          >
                            <category.icon />
                            <span>{category.label}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </SidebarContent>
            </Sidebar>
            <main className="flex flex-1 flex-col overflow-hidden min-h-0 h-full max-h-full">
              {/* Header */}
              <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{t.weldconnect.templateCatalog.breadcrumbLabel}</span>
                  <span className="text-muted-foreground">/</span>
                  <span className="font-medium">
                    {categories.find(c => c.id === selectedCategory)?.label || t.weldconnect.components.workflowTemplate.allTemplates}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 -mr-2"
                  onClick={handleClose}
                >
                  <X className="h-4 w-4" />
                </Button>
              </header>

              {/* Templates List */}
              <div className="flex-1 min-h-0 overflow-y-auto pl-4 pr-3 pt-3 pb-4 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20 [&::-webkit-scrollbar-thumb]:rounded-full">
                {/* Search */}
                <div className="relative mb-5">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t.weldconnect.templates.searchPlaceholder}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9 h-9"
                  />
                </div>

                {filteredTemplates.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Sparkles className="h-8 w-8 mb-2" />
                    <p className="text-sm">{t.weldconnect.templates.noTemplates}</p>
                  </div>
                ) : selectedCategory !== "all" ? (
                  <div>
                    {(() => {
                      const cat = categories.find(c => c.id === selectedCategory);
                      if (!cat) return null;
                      const CatIcon = cat.icon;
                      return (
                        <div className="flex items-center gap-2 mb-3">
                          <CatIcon className="h-4 w-4 text-muted-foreground" />
                          <h3 className="text-sm font-medium">{cat.label}</h3>
                          <span className="text-xs text-muted-foreground">({filteredTemplates.length})</span>
                        </div>
                      );
                    })()}
                    <div className="grid grid-cols-2 gap-3">
                      {filteredTemplates.map((template) => (
                        <TemplateCard key={template.id} template={template} onClick={() => handleTemplateClick(template)} />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {categories.filter(c => c.id !== "all").map(category => {
                      const categoryTemplates = filteredTemplates.filter(t => t.category === category.id);
                      if (categoryTemplates.length === 0) return null;
                      const CatIcon = category.icon;
                      return (
                        <div key={category.id}>
                          <div className="flex items-center gap-2 mb-3">
                            <CatIcon className="h-4 w-4 text-muted-foreground" />
                            <h3 className="text-sm font-medium">{category.label}</h3>
                            <span className="text-xs text-muted-foreground">({categoryTemplates.length})</span>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            {categoryTemplates.map((template) => (
                              <TemplateCard key={template.id} template={template} onClick={() => handleTemplateClick(template)} />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-4 py-3 border-t flex items-center justify-between shrink-0">
                <p className="text-xs text-muted-foreground">
                  {(filteredTemplates.length === 1
                    ? t.weldconnect.templateCatalog.templateCount
                    : t.weldconnect.templateCatalog.templateCountPlural
                  ).replace('{count}', String(filteredTemplates.length))}
                </p>
                <Button variant="outline" size="sm" onClick={handleStartFromScratch}>
                  {t.weldconnect.templateCatalog.startFromScratch}
                </Button>
              </div>
            </main>
          </SidebarProvider>
        )}
      </DialogContent>
    </Dialog>
  );
}
