"use client"

import * as React from 'react';
import { useState, useMemo } from 'react';
import { Input } from '../../input';
import { Button } from '../../button';
import { ScrollArea } from '../../scroll-area';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../../popover';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../collapsible';
import {
  Variable,
  Search,
  ChevronRight,
  Zap,
  GitBranch,
  Settings,
  Globe,
} from 'lucide-react';
import { cn } from '../../../lib/utils';

// Types for variable structure
export interface VariableGroup {
  id: string;
  label: string;
  icon: React.ReactNode;
  variables: VariableItem[];
}

export interface VariableItem {
  path: string;
  label: string;
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
}

interface VariablePickerProps {
  trigger: React.ReactNode;
  onSelect: (variable: string) => void;
  triggerType?: string;
  triggerData?: Record<string, unknown>;
  steps?: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  workflowVariables?: Array<{
    name: string;
    type?: string;
  }>;
  extraVariableGroups?: VariableGroup[];
  excludeGroups?: string[];
  className?: string;
  labels?: {
    searchPlaceholder?: string;
    clickToInsertHint?: string;
    noVariablesFound?: string;
    insertButton?: string;
    variablesButton?: string;
    groups?: {
      workflowVariables?: string;
      environment?: string;
    };
  };
}

function getStepOutputVariables(stepType: string): VariableItem[] {
  const commonOutputs: Record<string, VariableItem[]> = {
    send_email: [
      { path: 'success', label: 'Success', type: 'boolean' },
      { path: 'messageId', label: 'Message ID', type: 'string' },
      { path: 'from', label: 'Sender Email', type: 'string' },
    ],
    http_request: [
      { path: 'status', label: 'Status Code', type: 'number' },
      { path: 'body', label: 'Response Body', type: 'object' },
      { path: 'headers', label: 'Response Headers', type: 'object' },
      { path: 'ok', label: 'Success', type: 'boolean' },
    ],
    create_record: [
      { path: 'created', label: 'Created', type: 'boolean' },
      { path: 'record', label: 'Created Record', type: 'object' },
      { path: 'record.id', label: 'Record ID', type: 'string' },
    ],
    update_record: [
      { path: 'updated', label: 'Updated', type: 'boolean' },
      { path: 'record', label: 'Updated Record', type: 'object' },
      { path: 'record.id', label: 'Record ID', type: 'string' },
    ],
    delete_record: [{ path: 'deleted', label: 'Deleted', type: 'boolean' }],
    query_data: [
      { path: 'records', label: 'Records', type: 'array' },
      { path: 'count', label: 'Count', type: 'number' },
    ],
    condition: [{ path: 'result', label: 'Result', type: 'boolean' }],
    transform: [{ path: 'result', label: 'Transformed Data', type: 'object' }],
    set_variable: [
      { path: 'name', label: 'Variable Name', type: 'string' },
      { path: 'value', label: 'Variable Value', type: 'string' },
    ],
    loop: [
      { path: 'items', label: 'Loop Results', type: 'array' },
      { path: 'count', label: 'Item Count', type: 'number' },
    ],
    delay: [
      { path: 'delayed', label: 'Delayed', type: 'boolean' },
      { path: 'duration', label: 'Duration', type: 'string' },
    ],
    send_notification: [
      { path: 'sent', label: 'Sent', type: 'boolean' },
      { path: 'notificationIds', label: 'Notification IDs', type: 'array' },
      { path: 'count', label: 'Notification Count', type: 'number' },
      { path: 'message', label: 'Message', type: 'string' },
    ],
    assign_conversation: [
      { path: 'success', label: 'Success', type: 'boolean' },
      { path: 'conversationId', label: 'Conversation ID', type: 'string' },
      { path: 'strategy', label: 'Strategy', type: 'string' },
    ],
    tag_conversation: [
      { path: 'success', label: 'Success', type: 'boolean' },
      { path: 'tags', label: 'Updated Tags', type: 'array' },
    ],
    change_conversation_status: [
      { path: 'success', label: 'Success', type: 'boolean' },
      { path: 'status', label: 'New Status', type: 'string' },
    ],
    send_reply: [
      { path: 'success', label: 'Success', type: 'boolean' },
      { path: 'messageId', label: 'Message ID', type: 'string' },
    ],
  };

  return commonOutputs[stepType] || [{ path: 'result', label: 'Result', type: 'object' }];
}

function getTriggerVariables(triggerType?: string): VariableItem[] {
  const triggerOutputs: Record<string, VariableItem[]> = {
    manual: [
      { path: 'userId', label: 'User ID', type: 'string' },
      { path: 'timestamp', label: 'Timestamp', type: 'string' },
    ],
    schedule: [
      { path: 'scheduledTime', label: 'Scheduled Time', type: 'string' },
      { path: 'runId', label: 'Run ID', type: 'string' },
    ],
    webhook: [
      { path: 'body', label: 'Request Body', type: 'object' },
      { path: 'headers', label: 'Request Headers', type: 'object' },
      { path: 'query', label: 'Query Parameters', type: 'object' },
      { path: 'method', label: 'HTTP Method', type: 'string' },
    ],
    entity_event: [
      { path: 'entity', label: 'Entity Type', type: 'string' },
      { path: 'event', label: 'Event Type', type: 'string' },
      { path: 'recordId', label: 'Record ID', type: 'string' },
      { path: 'record', label: 'Record Data', type: 'object' },
      { path: 'previousRecord', label: 'Previous Data', type: 'object' },
      { path: 'changes', label: 'Changed Fields', type: 'object' },
    ],
  };

  return triggerOutputs[triggerType || ''] || [{ path: 'data', label: 'Trigger Data', type: 'object' }];
}

export function buildAllVariables({
  triggerType,
  steps = [],
  workflowVariables = [],
  extraVariableGroups = [],
  excludeGroups = [],
}: {
  triggerType?: string;
  steps?: Array<{ id: string; name: string; type: string }>;
  workflowVariables?: Array<{ name: string; type?: string }>;
  extraVariableGroups?: VariableGroup[];
  excludeGroups?: string[];
}): Array<VariableItem & { group: string }> {
  const items: Array<VariableItem & { group: string }> = [];

  if (!excludeGroups.includes('trigger')) {
    const triggerVars = getTriggerVariables(triggerType);
    for (const v of triggerVars) {
      items.push({ ...v, path: `trigger.${v.path}`, group: 'Trigger Data' });
    }
  }

  for (const g of extraVariableGroups) {
    for (const v of g.variables) {
      items.push({ ...v, group: g.label });
    }
  }

  steps.forEach((step, index) => {
    const stepVars = getStepOutputVariables(step.type);
    for (const v of stepVars) {
      items.push({ ...v, path: `steps.${step.id}.${v.path}`, group: `Step ${index + 1}: ${step.name}` });
    }
  });

  if (!excludeGroups.includes('variables')) {
    for (const v of workflowVariables) {
      items.push({
        path: `variables.${v.name}`,
        label: v.name,
        type: (v.type as VariableItem['type']) || 'string',
        group: 'Workflow Variables',
      });
    }
  }

  if (!excludeGroups.includes('env')) {
    items.push({ path: 'env.NODE_ENV', label: 'Environment', type: 'string', group: 'Environment' });
  }

  return items;
}

export function VariablePicker({
  trigger,
  onSelect,
  triggerType,
  steps = [],
  workflowVariables = [],
  extraVariableGroups = [],
  excludeGroups = [],
  className,
  labels = {},
}: VariablePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<string[]>(['trigger']);

  const variableGroups = useMemo<VariableGroup[]>(() => {
    const groups: VariableGroup[] = [];

    if (!excludeGroups.includes('trigger')) {
      const triggerVars = getTriggerVariables(triggerType);
      groups.push({
        id: 'trigger',
        label: 'Trigger Data',
        icon: <Zap className="h-4 w-4 text-yellow-500" />,
        variables: triggerVars.map((v) => ({ ...v, path: `trigger.${v.path}` })),
      });
    }

    groups.push(...extraVariableGroups);

    steps.forEach((step, index) => {
      const stepVars = getStepOutputVariables(step.type);
      groups.push({
        id: `step_${step.id}`,
        label: `Step ${index + 1}: ${step.name}`,
        icon: <GitBranch className="h-4 w-4 text-blue-500" />,
        variables: stepVars.map((v) => ({ ...v, path: `steps.${step.id}.${v.path}` })),
      });
    });

    if (!excludeGroups.includes('variables') && workflowVariables.length > 0) {
      groups.push({
        id: 'variables',
        label: labels.groups?.workflowVariables || 'Workflow Variables',
        icon: <Settings className="h-4 w-4 text-purple-500" />,
        variables: workflowVariables.map((v) => ({
          path: `variables.${v.name}`,
          label: v.name,
          type: (v.type as VariableItem['type']) || 'string',
        })),
      });
    }

    if (!excludeGroups.includes('env')) {
      groups.push({
        id: 'env',
        label: labels.groups?.environment || 'Environment',
        icon: <Globe className="h-4 w-4 text-green-500" />,
        variables: [{ path: 'env.NODE_ENV', label: 'Environment', type: 'string' as const }],
      });
    }

    return groups;
  }, [triggerType, steps, workflowVariables, extraVariableGroups, excludeGroups, labels]);

  const filteredGroups = useMemo(() => {
    if (!search) return variableGroups;
    const searchLower = search.toLowerCase();
    return variableGroups
      .map((group) => ({
        ...group,
        variables: group.variables.filter(
          (v) =>
            v.path.toLowerCase().includes(searchLower) ||
            v.label.toLowerCase().includes(searchLower)
        ),
      }))
      .filter((group) => group.variables.length > 0);
  }, [variableGroups, search]);

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) =>
      prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId]
    );
  };

  const handleSelect = (path: string) => {
    onSelect(`{{${path}}}`);
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className={cn('w-80 p-0', className)} align="start" side="bottom">
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={labels.searchPlaceholder || 'Search variables...'}
              className="pl-8 h-8"
            />
          </div>
        </div>

        <ScrollArea className="h-[300px]">
          <div className="p-1">
            {filteredGroups.map((group) => (
              <Collapsible
                key={group.id}
                open={expandedGroups.includes(group.id) || !!search}
                onOpenChange={() => toggleGroup(group.id)}
              >
                <CollapsibleTrigger asChild>
                  <button className="w-full flex items-center gap-2 px-2 py-1.5 text-sm font-medium hover:bg-muted rounded-md">
                    <ChevronRight
                      className={cn(
                        'h-4 w-4 transition-transform',
                        (expandedGroups.includes(group.id) || search) && 'rotate-90'
                      )}
                    />
                    {group.icon}
                    <span className="truncate">{group.label}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{group.variables.length}</span>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="ml-4 pl-2 border-l">
                    {group.variables.map((variable) => (
                      <button
                        key={variable.path}
                        onClick={() => handleSelect(variable.path)}
                        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-sm hover:bg-muted rounded-md group"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Variable className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="truncate">{variable.label}</span>
                        </div>
                        <code className="text-xs text-muted-foreground bg-muted px-1 rounded shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          {variable.type || 'any'}
                        </code>
                      </button>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ))}

            {filteredGroups.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {labels.noVariablesFound || 'No variables found'}
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="p-2 border-t bg-muted/30">
          <p className="text-xs text-muted-foreground text-center">
            {labels.clickToInsertHint || 'Click to insert as'}{' '}
            <code className="bg-muted px-1 rounded">{'{{path}}'}</code>
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function VariablePickerButton({
  onSelect,
  labels = {},
  ...props
}: Omit<VariablePickerProps, 'trigger'>) {
  return (
    <VariablePicker
      {...props}
      onSelect={onSelect}
      labels={labels}
      trigger={
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1">
          <Variable className="h-3 w-3" />
          {labels.variablesButton || 'Variables'}
        </Button>
      }
    />
  );
}
