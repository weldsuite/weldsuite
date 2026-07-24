import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Badge } from '@weldsuite/ui/components/badge';
import { Bot, UserPlus, Star, MessageSquare } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import type { WorkflowStep, WorkflowTrigger } from '../[id]/edit/types';

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  icon: React.ElementType;
  badge?: string;
  steps: WorkflowStep[];
  triggers: WorkflowTrigger[];
}

const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  // ── AI Support Bot ──
  {
    id: 'ai-support-bot',
    name: 'AI Support Bot',
    description: 'Greet the customer, ask what they need, then let the AI agent handle the conversation',
    icon: Bot,
    badge: 'Recommended',
    triggers: [
      {
        id: 'trig-1',
        type: 'entity_event',
        name: 'New conversation',
        isEnabled: true,
        entityType: 'helpdesk_conversation',
        eventType: 'created',
        config: { type: 'entity_event', entityType: 'helpdesk_conversation', eventType: 'created' },
      },
    ],
    steps: [
      {
        id: 'step-1',
        type: 'send_message',
        name: 'Greeting',
        config: { message: 'Hi there! Thanks for reaching out. I\'m here to help you.' },
        order: 0,
      },
      {
        id: 'step-2',
        type: 'send_choices',
        name: 'What do you need?',
        config: {
          message: 'What can I help you with today?',
          options: [
            { id: 'opt-question', label: 'I have a question', value: 'question' },
            { id: 'opt-issue', label: 'Report an issue', value: 'issue' },
            { id: 'opt-billing', label: 'Billing & account', value: 'billing' },
            { id: 'opt-other', label: 'Something else', value: 'other' },
          ],
        },
        order: 1,
      },
      {
        id: 'step-3',
        type: 'tag_conversation',
        name: 'Tag with topic',
        config: { tags: ['{{steps.step-2.selectedValue}}'] },
        order: 2,
      },
      {
        id: 'step-4',
        type: 'collect_input',
        name: 'Collect email',
        config: {
          message: 'Could you share your email address so we can follow up?',
          fields: [{ id: 'email', label: 'Email', type: 'email', required: true }],
        },
        order: 3,
      },
      {
        id: 'step-5',
        type: 'ai_auto_reply',
        name: 'AI Agent',
        config: {},
        order: 4,
      },
    ],
  },

  // ── Smart Topic Router ──
  {
    id: 'topic-router',
    name: 'Smart Topic Router',
    description: 'Ask the customer what they need help with, then route to the right team',
    icon: MessageSquare,
    triggers: [
      {
        id: 'trig-1',
        type: 'entity_event',
        name: 'New conversation',
        isEnabled: true,
        entityType: 'helpdesk_conversation',
        eventType: 'created',
        config: { type: 'entity_event', entityType: 'helpdesk_conversation', eventType: 'created' },
      },
    ],
    steps: [
      {
        id: 'step-1',
        type: 'send_message',
        name: 'Greeting',
        config: { message: 'Hi! Let me make sure you get to the right team.' },
        order: 0,
      },
      {
        id: 'step-2',
        type: 'send_choices',
        name: 'Ask department',
        config: {
          message: 'Which team can help you best?',
          options: [
            { id: 'opt-support', label: 'Technical Support', value: 'support' },
            { id: 'opt-billing', label: 'Billing', value: 'billing' },
            { id: 'opt-sales', label: 'Sales', value: 'sales' },
          ],
        },
        order: 1,
      },
      {
        id: 'step-3',
        type: 'assign_conversation',
        name: 'Assign to team',
        config: { strategy: 'round_robin' },
        order: 2,
      },
      {
        id: 'step-4',
        type: 'send_message',
        name: 'Handoff message',
        config: { message: 'Thanks! A team member will be with you shortly.' },
        order: 3,
      },
    ],
  },

  // ── Lead Qualification ──
  {
    id: 'lead-qualification',
    name: 'Lead Qualification',
    description: 'Qualify new visitors by asking who they are and what they need, then route accordingly',
    icon: UserPlus,
    triggers: [
      {
        id: 'trig-1',
        type: 'entity_event',
        name: 'New conversation',
        isEnabled: true,
        entityType: 'helpdesk_conversation',
        eventType: 'created',
        config: { type: 'entity_event', entityType: 'helpdesk_conversation', eventType: 'created' },
      },
    ],
    steps: [
      {
        id: 'step-1',
        type: 'send_message',
        name: 'Welcome',
        config: { message: 'Welcome! Let me connect you with the right person.' },
        order: 0,
      },
      {
        id: 'step-2',
        type: 'send_choices',
        name: 'Who are you?',
        config: {
          message: 'Are you a current customer or looking to learn more?',
          options: [
            { id: 'opt-customer', label: 'I\'m a customer', value: 'customer' },
            { id: 'opt-prospect', label: 'I\'m exploring', value: 'prospect' },
            { id: 'opt-partner', label: 'Partnership inquiry', value: 'partner' },
          ],
        },
        order: 1,
      },
      {
        id: 'step-3',
        type: 'collect_input',
        name: 'Collect info',
        config: {
          message: 'Could you share your name and email?',
          fields: [
            { id: 'name', label: 'Name', type: 'text', required: true },
            { id: 'email', label: 'Email', type: 'email', required: true },
          ],
        },
        order: 2,
      },
      {
        id: 'step-4',
        type: 'assign_conversation',
        name: 'Route to team',
        config: { strategy: 'round_robin' },
        order: 3,
      },
    ],
  },

  // ── CSAT After Close ──
  {
    id: 'csat-after-close',
    name: 'CSAT After Close',
    description: 'Send a satisfaction survey after a conversation is closed',
    icon: Star,
    triggers: [
      {
        id: 'trig-1',
        type: 'entity_event',
        name: 'Conversation closed',
        isEnabled: true,
        entityType: 'helpdesk_conversation',
        eventType: 'closed',
        config: { type: 'entity_event', entityType: 'helpdesk_conversation', eventType: 'closed' },
      },
    ],
    steps: [
      {
        id: 'step-1',
        type: 'delay',
        name: 'Wait 2 minutes',
        config: { duration: 2, unit: 'minutes' },
        order: 0,
      },
      {
        id: 'step-2',
        type: 'send_message',
        name: 'Thank you',
        config: { message: 'We hope we were able to help! Your feedback helps us improve.' },
        order: 1,
      },
      {
        id: 'step-3',
        type: 'trigger_csat',
        name: 'CSAT Survey',
        config: {},
        order: 2,
      },
    ],
  },
];

interface WorkflowTemplatesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: { name: string; description: string; steps: WorkflowStep[]; triggers: WorkflowTrigger[] }) => void;
}

export function WorkflowTemplatesDialog({ open, onOpenChange, onSelect }: WorkflowTemplatesDialogProps) {
  const { t } = useI18n();
  const tr = t.helpdesk.workflowTemplates;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tr.dialogTitle}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground -mt-2">
          {tr.dialogDescription}
        </p>
        <div className="grid gap-3 mt-1">
          {WORKFLOW_TEMPLATES.map((template) => {
            const Icon = template.icon;
            return (
              <Button
                key={template.id}
                type="button"
                variant="ghost"
                onClick={() => onSelect(template)}
                className="flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary/30 hover:bg-muted/50 transition-colors text-left"
              >
                <div className="flex-shrink-0 w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center mt-0.5">
                  <Icon className="w-4 h-4 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{template.name}</p>
                    {template.badge && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        {tr.recommended}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{template.description}</p>
                  <p className="text-xs text-muted-foreground mt-1">{tr.stepsCount.replace('{count}', String(template.steps.length))}</p>
                </div>
              </Button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
