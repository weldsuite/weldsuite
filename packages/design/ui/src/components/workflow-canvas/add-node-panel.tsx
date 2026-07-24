"use client"

import * as React from 'react';
import { useState, useMemo } from 'react';
import { Button } from '../button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../popover';
import { ScrollArea } from '../scroll-area';
import { Input } from '../input';
import {
  Plus,
  Mail,
  Globe,
  Clock,
  GitBranch,
  Repeat,
  Variable,
  Wand2,
  Pencil,
  Trash2,
  Search,
  Bell,
  Code,
  Sparkles,
  FileSearch,
  FileText,
  MessageSquareText,
  ListChecks,
  ClipboardList,
  Bot,
  UserCheck,
} from 'lucide-react';
import { cn } from '../../lib/utils';

interface ActionTypeOption {
  id: string;
  name: string;
  description: string;
  icon: React.ElementType;
  category: 'communication' | 'data' | 'logic' | 'integration' | 'ai' | 'helpdesk';
}

const ACTION_ICONS: Record<string, React.ElementType> = {
  send_email: Mail,
  send_notification: Bell,
  create_record: Plus,
  update_record: Pencil,
  delete_record: Trash2,
  query_data: Search,
  set_variable: Variable,
  transform_data: Wand2,
  condition: GitBranch,
  loop: Repeat,
  delay: Clock,
  manual_step: UserCheck,
  http_request: Globe,
  run_script: Code,
  ai_generate: Sparkles,
  ai_extract: FileSearch,
  ai_summarize: FileText,
  ai_agent: Bot,
  send_message: MessageSquareText,
  send_choices: ListChecks,
  collect_input: ClipboardList,
};

const ACTION_CATEGORIES: Record<string, ActionTypeOption['category']> = {
  send_email: 'communication',
  send_notification: 'communication',
  create_record: 'data',
  update_record: 'data',
  delete_record: 'data',
  query_data: 'data',
  set_variable: 'data',
  transform_data: 'data',
  condition: 'logic',
  loop: 'logic',
  delay: 'logic',
  manual_step: 'logic',
  http_request: 'integration',
  run_script: 'integration',
  ai_generate: 'ai',
  ai_extract: 'ai',
  ai_summarize: 'ai',
  ai_agent: 'ai',
  send_message: 'helpdesk',
  send_choices: 'helpdesk',
  collect_input: 'helpdesk',
};

const categoryColors: Record<string, string> = {
  communication: 'text-blue-500',
  data: 'text-green-500',
  logic: 'text-amber-500',
  integration: 'text-pink-500',
  ai: 'text-violet-500',
  helpdesk: 'text-cyan-500',
};

export interface AddNodePanelLabels {
  addStep?: string;
  searchPlaceholder?: string;
  noActionsFound?: string;
  actions?: Record<string, { name: string; description: string }>;
  categories?: Record<string, string>;
}

interface AddNodePanelProps {
  onAddAction: (actionType: string) => void;
  module?: 'helpdesk' | 'general';
  /** i18n strings — all optional; English defaults are built in. */
  labels?: AddNodePanelLabels;
}

const DEFAULT_CATEGORY_LABELS: Record<string, string> = {
  communication: 'Communication',
  data: 'Data',
  logic: 'Logic',
  integration: 'Integration',
  ai: 'AI',
  helpdesk: 'Helpdesk',
};

const DEFAULT_ACTION_LABELS: Record<string, { name: string; description: string }> = {
  send_email: { name: 'Send Email', description: 'Send an email message' },
  send_notification: { name: 'Send Notification', description: 'Send a push notification' },
  create_record: { name: 'Create Record', description: 'Create a new record' },
  update_record: { name: 'Update Record', description: 'Update an existing record' },
  delete_record: { name: 'Delete Record', description: 'Delete a record' },
  query_data: { name: 'Query Data', description: 'Query records from the database' },
  set_variable: { name: 'Set Variable', description: 'Set a workflow variable' },
  transform_data: { name: 'Transform Data', description: 'Transform or map data' },
  condition: { name: 'Condition', description: 'Branch based on a condition' },
  loop: { name: 'Loop', description: 'Iterate over a list' },
  delay: { name: 'Delay', description: 'Wait for a duration' },
  manual_step: { name: 'Manual Step', description: 'Pause for manual approval' },
  http_request: { name: 'HTTP Request', description: 'Make an HTTP API call' },
  run_script: { name: 'Run Script', description: 'Execute a custom script' },
  ai_generate: { name: 'AI Generate', description: 'Generate text with AI' },
  ai_extract: { name: 'AI Extract', description: 'Extract data with AI' },
  ai_summarize: { name: 'AI Summarize', description: 'Summarize content with AI' },
  ai_agent: { name: 'AI Agent', description: 'Run an AI agent with sub-agents' },
  send_message: { name: 'Send Message', description: 'Send a chat bot message' },
  send_choices: { name: 'Send Choices', description: 'Present choice buttons' },
  collect_input: { name: 'Collect Input', description: 'Collect user input' },
};

export function AddNodePanel({ onAddAction, module, labels = {} }: AddNodePanelProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const actionLocales = labels.actions || DEFAULT_ACTION_LABELS;

  const actionTypes = useMemo<ActionTypeOption[]>(() => {
    return Object.entries(ACTION_ICONS).map(([id, icon]) => ({
      id,
      name: actionLocales[id]?.name ?? DEFAULT_ACTION_LABELS[id]?.name ?? id,
      description: actionLocales[id]?.description ?? DEFAULT_ACTION_LABELS[id]?.description ?? '',
      icon,
      category: ACTION_CATEGORIES[id] as ActionTypeOption['category'],
    }));
  }, [actionLocales]);

  const visibleActions = module === 'helpdesk'
    ? actionTypes
    : actionTypes.filter((a) => a.category !== 'helpdesk');

  const filteredActions = visibleActions.filter(
    (action) =>
      action.name.toLowerCase().includes(search.toLowerCase()) ||
      action.description.toLowerCase().includes(search.toLowerCase())
  );

  const groupedActions = filteredActions.reduce(
    (acc, action) => {
      const group = acc[action.category] ?? (acc[action.category] = []);
      group.push(action);
      return acc;
    },
    {} as Record<string, ActionTypeOption[]>
  );

  const handleSelect = (actionType: string) => {
    onAddAction(actionType);
    setOpen(false);
    setSearch('');
  };

  const categoryLabels = labels.categories || DEFAULT_CATEGORY_LABELS;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="lg" className="gap-2 shadow-lg">
          <Plus className="h-5 w-5" />
          {labels.addStep || 'Add Step'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end" side="top" sideOffset={8}>
        <div className="p-3 border-b">
          <Input
            placeholder={labels.searchPlaceholder || 'Search actions...'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9"
          />
        </div>
        <ScrollArea className="h-[400px]">
          <div className="py-2">
            {Object.entries(groupedActions).map(([category, actions]) => (
              <div key={category} className="mb-4">
                <div className={cn('text-xs font-semibold uppercase tracking-wide py-1', categoryColors[category])}>
                  {categoryLabels[category] ?? category}
                </div>
                <div className="space-y-1 mt-1">
                  {actions.map((action) => {
                    const Icon = action.icon;
                    return (
                      <button
                        key={action.id}
                        onClick={() => handleSelect(action.id)}
                        className={cn('w-full flex items-center gap-3 py-2 rounded-lg', 'hover:bg-muted transition-colors', 'text-left')}
                      >
                        <div className={cn('flex items-center justify-center w-8 h-8 rounded-md', 'bg-muted')}>
                          <Icon className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">{action.name}</div>
                          <div className="text-xs text-muted-foreground truncate">{action.description}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {filteredActions.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <p>{labels.noActionsFound || 'No actions found'}</p>
              </div>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
