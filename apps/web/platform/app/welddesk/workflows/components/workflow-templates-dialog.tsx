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

type TemplateContent = ReturnType<typeof useI18n>['t']['helpdesk']['workflowTemplateContent'];

const getWorkflowTemplates = (c: TemplateContent): WorkflowTemplate[] => [
  // ── AI Support Bot ──
  {
    id: 'ai-support-bot',
    name: c.aiBotName,
    description: c.aiBotDescription,
    icon: Bot,
    badge: 'Recommended',
    triggers: [
      {
        id: 'trig-1',
        type: 'entity_event',
        name: c.triggerNewConversation,
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
        name: c.stepGreeting,
        config: { message: c.aiBotGreetingMessage },
        order: 0,
      },
      {
        id: 'step-2',
        type: 'send_choices',
        name: c.stepWhatDoYouNeed,
        config: {
          message: c.msgWhatCanIHelp,
          options: [
            { id: 'opt-question', label: c.optQuestion, value: 'question' },
            { id: 'opt-issue', label: c.optIssue, value: 'issue' },
            { id: 'opt-billing', label: c.optBillingAccount, value: 'billing' },
            { id: 'opt-other', label: c.optSomethingElse, value: 'other' },
          ],
        },
        order: 1,
      },
      {
        id: 'step-3',
        type: 'tag_conversation',
        name: c.stepTagWithTopic,
        config: { tags: ['{{steps.step-2.selectedValue}}'] },
        order: 2,
      },
      {
        id: 'step-4',
        type: 'collect_input',
        name: c.stepCollectEmail,
        config: {
          message: c.msgShareEmail,
          fields: [{ id: 'email', label: c.fieldEmail, type: 'email', required: true }],
        },
        order: 3,
      },
      {
        id: 'step-5',
        type: 'ai_auto_reply',
        name: c.stepAiAgent,
        config: {},
        order: 4,
      },
    ],
  },

  // ── Smart Topic Router ──
  {
    id: 'topic-router',
    name: c.routerName,
    description: c.routerDescription,
    icon: MessageSquare,
    triggers: [
      {
        id: 'trig-1',
        type: 'entity_event',
        name: c.triggerNewConversation,
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
        name: c.stepGreeting,
        config: { message: c.routerGreetingMessage },
        order: 0,
      },
      {
        id: 'step-2',
        type: 'send_choices',
        name: c.stepAskDepartment,
        config: {
          message: c.msgWhichTeam,
          options: [
            { id: 'opt-support', label: c.optTechnicalSupport, value: 'support' },
            { id: 'opt-billing', label: c.optBilling, value: 'billing' },
            { id: 'opt-sales', label: c.optSales, value: 'sales' },
          ],
        },
        order: 1,
      },
      {
        id: 'step-3',
        type: 'assign_conversation',
        name: c.stepAssignToTeam,
        config: { strategy: 'round_robin' },
        order: 2,
      },
      {
        id: 'step-4',
        type: 'send_message',
        name: c.stepHandoffMessage,
        config: { message: c.msgHandoff },
        order: 3,
      },
    ],
  },

  // ── Lead Qualification ──
  {
    id: 'lead-qualification',
    name: c.leadName,
    description: c.leadDescription,
    icon: UserPlus,
    triggers: [
      {
        id: 'trig-1',
        type: 'entity_event',
        name: c.triggerNewConversation,
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
        name: c.stepWelcome,
        config: { message: c.msgWelcome },
        order: 0,
      },
      {
        id: 'step-2',
        type: 'send_choices',
        name: c.stepWhoAreYou,
        config: {
          message: c.msgCustomerOrNot,
          options: [
            { id: 'opt-customer', label: c.optImCustomer, value: 'customer' },
            { id: 'opt-prospect', label: c.optImExploring, value: 'prospect' },
            { id: 'opt-partner', label: c.optPartnership, value: 'partner' },
          ],
        },
        order: 1,
      },
      {
        id: 'step-3',
        type: 'collect_input',
        name: c.stepCollectInfo,
        config: {
          message: c.msgShareNameEmail,
          fields: [
            { id: 'name', label: c.fieldName, type: 'text', required: true },
            { id: 'email', label: c.fieldEmail, type: 'email', required: true },
          ],
        },
        order: 2,
      },
      {
        id: 'step-4',
        type: 'assign_conversation',
        name: c.stepRouteToTeam,
        config: { strategy: 'round_robin' },
        order: 3,
      },
    ],
  },

  // ── CSAT After Close ──
  {
    id: 'csat-after-close',
    name: c.csatName,
    description: c.csatDescription,
    icon: Star,
    triggers: [
      {
        id: 'trig-1',
        type: 'entity_event',
        name: c.triggerConversationClosed,
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
        name: c.stepWait2Minutes,
        config: { duration: 2, unit: 'minutes' },
        order: 0,
      },
      {
        id: 'step-2',
        type: 'send_message',
        name: c.stepThankYou,
        config: { message: c.msgCsat },
        order: 1,
      },
      {
        id: 'step-3',
        type: 'trigger_csat',
        name: c.stepCsatSurvey,
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

export function WorkflowTemplatesDialog({ open, onOpenChange, onSelect }: Readonly<WorkflowTemplatesDialogProps>) {
  const { t } = useI18n();
  const tr = t.helpdesk.workflowTemplates;
  const templates = React.useMemo(
    () => getWorkflowTemplates(t.helpdesk.workflowTemplateContent),
    [t.helpdesk.workflowTemplateContent],
  );

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
          {templates.map((template) => {
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
