"use client"

import * as React from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '../../select';
import {
  Users,
  ShoppingCart,
  FolderKanban,
  HelpCircle,
  Mail,
  GitBranch,
  Globe,
} from 'lucide-react';

export interface EntityTypeOption {
  value: string;
  label: string;
  description?: string;
}

export interface EntityTypeGroup {
  id: string;
  label: string;
  icon: React.ReactNode;
  entities: EntityTypeOption[];
}

export const ENTITY_TYPE_GROUPS: EntityTypeGroup[] = [
  {
    id: 'crm',
    label: 'CRM',
    icon: <Users className="h-4 w-4" />,
    entities: [
      { value: 'lead', label: 'Lead', description: 'Sales leads' },
      { value: 'customer', label: 'Customer', description: 'Customer accounts' },
      { value: 'contact', label: 'Contact', description: 'Contact persons' },
      { value: 'opportunity', label: 'Opportunity', description: 'Sales opportunities' },
      { value: 'activity', label: 'Activity', description: 'CRM activities' },
      { value: 'pipeline_stage', label: 'Pipeline Stage', description: 'Sales pipeline stages' },
    ],
  },
  {
    id: 'helpdesk',
    label: 'Helpdesk',
    icon: <HelpCircle className="h-4 w-4" />,
    entities: [
      { value: 'ticket', label: 'Ticket', description: 'Support tickets' },
      { value: 'ticket_message', label: 'Ticket Message', description: 'Ticket replies' },
      { value: 'department', label: 'Department', description: 'Support departments' },
      { value: 'canned_response', label: 'Canned Response', description: 'Response templates' },
    ],
  },
  {
    id: 'commerce',
    label: 'Commerce',
    icon: <ShoppingCart className="h-4 w-4" />,
    entities: [
      { value: 'order', label: 'Order', description: 'Customer orders' },
      { value: 'product', label: 'Product', description: 'Product catalog' },
      { value: 'category', label: 'Category', description: 'Product categories' },
      { value: 'cart', label: 'Cart', description: 'Shopping carts' },
    ],
  },
  {
    id: 'projects',
    label: 'Projects',
    icon: <FolderKanban className="h-4 w-4" />,
    entities: [
      { value: 'project', label: 'Project', description: 'Projects' },
      { value: 'task', label: 'Task', description: 'Project tasks' },
      { value: 'milestone', label: 'Milestone', description: 'Project milestones' },
      { value: 'time_entry', label: 'Time Entry', description: 'Time tracking entries' },
      { value: 'project_file', label: 'Project File', description: 'Project files' },
      { value: 'project_member', label: 'Project Member', description: 'Project team members' },
    ],
  },
  {
    id: 'mail',
    label: 'Mail',
    icon: <Mail className="h-4 w-4" />,
    entities: [
      { value: 'mail_account', label: 'Mail Account', description: 'Email accounts' },
      { value: 'mail_message', label: 'Mail Message', description: 'Email messages' },
      { value: 'mail_folder', label: 'Mail Folder', description: 'Email folders' },
      { value: 'mail_template', label: 'Mail Template', description: 'Email templates' },
    ],
  },
  {
    id: 'workflow',
    label: 'Workflow',
    icon: <GitBranch className="h-4 w-4" />,
    entities: [
      { value: 'workflow', label: 'Workflow', description: 'Automation workflows' },
      { value: 'workflow_execution', label: 'Workflow Execution', description: 'Workflow runs' },
      { value: 'workflow_variable', label: 'Workflow Variable', description: 'Workflow variables' },
    ],
  },
  {
    id: 'host',
    label: 'Hosting',
    icon: <Globe className="h-4 w-4" />,
    entities: [
      { value: 'host_domain', label: 'Domain', description: 'Registered domains' },
    ],
  },
];

export const ALL_ENTITY_TYPES = ENTITY_TYPE_GROUPS.flatMap((g) => g.entities);

export function getEntityType(value: string): EntityTypeOption | undefined {
  return ALL_ENTITY_TYPES.find((e) => e.value === value);
}

export function getEntityGroup(value: string): EntityTypeGroup | undefined {
  return ENTITY_TYPE_GROUPS.find((g) => g.entities.some((e) => e.value === value));
}

interface EntityTypeSelectProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  allowedGroups?: string[];
  labels?: {
    placeholder?: string;
    groups?: Record<string, string>;
    entities?: Record<string, { label: string; description?: string }>;
  };
}

export function EntityTypeSelect({
  value,
  onChange,
  placeholder,
  disabled = false,
  className,
  allowedGroups,
  labels = {},
}: EntityTypeSelectProps) {
  const translatedGroups = ENTITY_TYPE_GROUPS.map((g) => {
    const groupLabels = labels.groups || {};
    const entityLabels = labels.entities || {};
    return {
      ...g,
      label: groupLabels[g.id] ?? g.label,
      entities: g.entities.map((e) => ({
        ...e,
        label: entityLabels[e.value]?.label ?? e.label,
        description: entityLabels[e.value]?.description ?? e.description,
      })),
    };
  });

  const groups = allowedGroups
    ? translatedGroups.filter((g) => allowedGroups.includes(g.id))
    : translatedGroups;

  const resolvedPlaceholder = placeholder ?? labels.placeholder ?? 'Select entity type...';
  const selectedEntity = translatedGroups.flatMap((g) => g.entities).find((e) => e.value === value);

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={resolvedPlaceholder}>
          {selectedEntity ? selectedEntity.label : resolvedPlaceholder}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {groups.map((group) => (
          <SelectGroup key={group.id}>
            <SelectLabel className="flex items-center gap-2">
              {group.icon}
              {group.label}
            </SelectLabel>
            {group.entities.map((entity) => (
              <SelectItem key={entity.value} value={entity.value}>
                <div className="flex flex-col">
                  <span>{entity.label}</span>
                  {entity.description && (
                    <span className="text-xs text-muted-foreground">{entity.description}</span>
                  )}
                </div>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
