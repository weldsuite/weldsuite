import React, { useState } from 'react';
import {
  Zap, X, Plus, Trash2, Filter, Lock,
  Globe, Mail, Phone, MessageCircle, Share2, Code, Smartphone,
  UserPlus, Users, Eye,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Input } from '@weldsuite/ui/components/input';
import { cn } from '@/lib/utils';
import { HELPDESK_ROUTING_TRIGGERS, WORKFLOW_CHANNELS, WORKFLOW_AUDIENCES } from '../helpdesk-workflow-constants';
import { useI18n } from '@/lib/i18n/provider';

// ============================================================================
// Channel / Audience icon map
// ============================================================================

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  Globe, Mail, Phone, MessageCircle, Share2, Code, Smartphone,
};

const AUDIENCE_ICONS: Record<string, React.ElementType> = {
  UserPlus, Users, Eye,
};

// ============================================================================
// Filter field definitions per entity type
// ============================================================================

interface FilterFieldDef {
  field: string;
  label: string;
  type: 'select' | 'text';
  options?: Array<{ value: string; label: string }>;
}

function getFieldDefs(entityType: string, conversationFields: FilterFieldDef[], ticketFields: FilterFieldDef[]): FilterFieldDef[] {
  if (entityType.startsWith('helpdesk_ticket')) return ticketFields;
  return conversationFields;
}

// ============================================================================
// Trigger Filter Panel
// ============================================================================

export interface TriggerFilter {
  field: string;
  operator: string;
  value: unknown;
}

export interface TriggerConfigUpdate {
  channels?: string[];
  audience?: string[];
  filters?: TriggerFilter[];
}

interface TriggerFilterPanelProps {
  workflow: any;
  onUpdateTriggerConfig: (config: TriggerConfigUpdate) => void;
  onClose: () => void;
}

export function TriggerFilterPanel({
  workflow,
  onUpdateTriggerConfig,
  onClose,
}: TriggerFilterPanelProps) {
  const { t } = useI18n();
  const tp = t.helpdesk.triggerPanel;

  const CONVERSATION_FILTER_FIELDS: FilterFieldDef[] = [
    {
      field: 'status',
      label: tp.fieldStatus,
      type: 'select',
      options: [
        { value: 'active', label: tp.statusActive },
        { value: 'pending', label: tp.statusPending },
        { value: 'resolved', label: tp.statusResolved },
        { value: 'closed', label: tp.statusClosed },
        { value: 'snoozed', label: tp.statusSnoozed },
        { value: 'archived', label: tp.statusArchived },
      ],
    },
    {
      field: 'priority',
      label: tp.fieldPriority,
      type: 'select',
      options: [
        { value: 'low', label: tp.priorityLow },
        { value: 'medium', label: tp.priorityMedium },
        { value: 'high', label: tp.priorityHigh },
        { value: 'urgent', label: tp.priorityUrgent },
        { value: 'critical', label: tp.priorityCritical },
      ],
    },
    { field: 'source', label: tp.fieldSource, type: 'text' },
    { field: 'customerEmail', label: tp.fieldCustomerEmail, type: 'text' },
    { field: 'customerCompany', label: tp.fieldCustomerCompany, type: 'text' },
  ];

  const TICKET_FILTER_FIELDS: FilterFieldDef[] = [
    {
      field: 'status',
      label: tp.fieldStatus,
      type: 'select',
      options: [
        { value: 'open', label: tp.statusOpen },
        { value: 'in_progress', label: tp.statusInProgress },
        { value: 'pending', label: tp.statusPending },
        { value: 'resolved', label: tp.statusResolved },
        { value: 'closed', label: tp.statusClosed },
      ],
    },
    {
      field: 'priority',
      label: tp.fieldPriority,
      type: 'select',
      options: [
        { value: 'low', label: tp.priorityLow },
        { value: 'medium', label: tp.priorityMedium },
        { value: 'high', label: tp.priorityHigh },
        { value: 'urgent', label: tp.priorityUrgent },
        { value: 'critical', label: tp.priorityCritical },
      ],
    },
    {
      field: 'category',
      label: tp.fieldCategory,
      type: 'select',
      options: [
        { value: 'technical_support', label: tp.categoryTechnicalSupport },
        { value: 'billing', label: tp.categoryBilling },
        { value: 'sales', label: tp.categorySales },
        { value: 'general_inquiry', label: tp.categoryGeneralInquiry },
        { value: 'feature_request', label: tp.categoryFeatureRequest },
        { value: 'bug_report', label: tp.categoryBugReport },
        { value: 'complaint', label: tp.categoryComplaint },
        { value: 'other', label: tp.categoryOther },
      ],
    },
    {
      field: 'severity',
      label: tp.fieldSeverity,
      type: 'select',
      options: [
        { value: 'minor', label: tp.severityMinor },
        { value: 'major', label: tp.severityMajor },
        { value: 'critical', label: tp.severityCritical },
        { value: 'blocker', label: tp.severityBlocker },
      ],
    },
    {
      field: 'type',
      label: tp.fieldType,
      type: 'select',
      options: [
        { value: 'question', label: tp.typeQuestion },
        { value: 'incident', label: tp.typeIncident },
        { value: 'problem', label: tp.typeProblem },
        { value: 'feature_request', label: tp.typeFeatureRequest },
        { value: 'service_request', label: tp.typeServiceRequest },
      ],
    },
    { field: 'source', label: tp.fieldSource, type: 'text' },
  ];

  const OPERATOR_OPTIONS = [
    { value: 'equals', label: tp.operatorEquals },
    { value: 'not_equals', label: tp.operatorNotEquals },
    { value: 'contains', label: tp.operatorContains },
    { value: 'not_contains', label: tp.operatorNotContains },
    { value: 'exists', label: tp.operatorExists },
    { value: 'not_exists', label: tp.operatorNotExists },
  ];

  const trigger = workflow.triggers?.[0];
  const entityType = trigger?.entityType || '';
  const eventType = trigger?.eventType || '';
  const triggerMeta = HELPDESK_ROUTING_TRIGGERS.find(
    (tr) => tr.entityType === entityType && tr.eventType === eventType,
  );

  // Resolve existing state from trigger config
  const existingFilters: TriggerFilter[] =
    trigger?.config?.filters || trigger?.filters || [];
  const existingChannels: string[] = trigger?.config?.channels || [];
  const existingAudience: string[] = trigger?.config?.audience || [];

  const [filters, setFilters] = useState<TriggerFilter[]>(existingFilters);
  const [channels, setChannels] = useState<string[]>(existingChannels);
  const [audience, setAudience] = useState<string[]>(existingAudience);

  const fieldDefs = getFieldDefs(entityType, CONVERSATION_FILTER_FIELDS, TICKET_FILTER_FIELDS);

  // Fields already used (can't add twice)
  const usedFields = new Set(filters.map((f) => f.field));
  const availableFields = fieldDefs.filter((fd) => !usedFields.has(fd.field));

  // Emit full config update
  const emitUpdate = (
    nextChannels: string[] = channels,
    nextAudience: string[] = audience,
    nextFilters: TriggerFilter[] = filters,
  ) => {
    onUpdateTriggerConfig({
      channels: nextChannels,
      audience: nextAudience,
      filters: nextFilters,
    });
  };

  // Channel toggle
  const toggleChannel = (value: string) => {
    const next = channels.includes(value)
      ? channels.filter((c) => c !== value)
      : [...channels, value];
    setChannels(next);
    emitUpdate(next, audience, filters);
  };

  // Audience toggle
  const toggleAudience = (value: string) => {
    const next = audience.includes(value)
      ? audience.filter((a) => a !== value)
      : [...audience, value];
    setAudience(next);
    emitUpdate(channels, next, filters);
  };

  // Filter CRUD
  const addFilter = () => {
    if (availableFields.length === 0) return;
    const first = availableFields[0];
    const newFilter: TriggerFilter = {
      field: first.field,
      operator: 'equals',
      value: '',
    };
    const updated = [...filters, newFilter];
    setFilters(updated);
    emitUpdate(channels, audience, updated);
  };

  const updateFilter = (index: number, patch: Partial<TriggerFilter>) => {
    const updated = filters.map((f, i) => (i === index ? { ...f, ...patch } : f));
    setFilters(updated);
    emitUpdate(channels, audience, updated);
  };

  const removeFilter = (index: number) => {
    const updated = filters.filter((_, i) => i !== index);
    setFilters(updated);
    emitUpdate(channels, audience, updated);
  };

  const needsValue = (op: string) => op !== 'exists' && op !== 'not_exists';

  return (
    <>
      {/* Header */}
      <div className="p-3 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-md bg-teal-100 dark:bg-teal-900/30">
              <Zap className="h-4 w-4 text-teal-600" />
            </div>
            <h3 className="font-semibold text-sm">{tp.title}</h3>
          </div>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">
          {/* Section 1: Trigger type — read-only */}
          <div>
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
              {tp.triggerLabel}
            </label>
            <div className="mt-1.5 rounded-lg border bg-muted/50 px-3 py-2.5">
              <div className="flex items-start gap-2">
                {triggerMeta && (
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-teal-100 dark:bg-teal-900/30 mt-0.5">
                    <triggerMeta.icon className="h-3.5 w-3.5 text-teal-600" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium block leading-snug">
                    {triggerMeta?.label || `${entityType}:${eventType}`}
                  </span>
                  {triggerMeta?.description && (
                    <span className="text-[11px] text-muted-foreground block mt-0.5 leading-snug">
                      {triggerMeta.description}
                    </span>
                  )}
                </div>
                <Lock className="h-3 w-3 text-muted-foreground/50 shrink-0 mt-1" />
              </div>
            </div>
          </div>

          {/* Section 2: Channels */}
          <div>
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
              {tp.channelsLabel}
            </label>
            <p className="text-[11px] text-muted-foreground mt-0.5 mb-2">
              {channels.length === 0 ? tp.allChannels : tp.channelsSelected.replace('{count}', String(channels.length))}
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {WORKFLOW_CHANNELS.map((ch) => {
                const Icon = CHANNEL_ICONS[ch.icon] || Globe;
                const active = channels.includes(ch.value);
                return (
                  <Button
                    key={ch.value}
                    type="button"
                    variant="ghost"
                    onClick={() => toggleChannel(ch.value)}
                    className={cn(
                      'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors',
                      active
                        ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-900/20 dark:text-teal-300 dark:border-teal-600'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted/50',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    {ch.label}
                  </Button>
                );
              })}
            </div>
          </div>

          {/* Section 3: Additional Filters */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {tp.additionalFilters}
                </label>
              </div>
              {filters.length > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  {tp.allConditionsMustMatch}
                </span>
              )}
            </div>

            {filters.length === 0 && (
              <p className="text-xs text-muted-foreground mb-2">
                {entityType.startsWith('helpdesk_ticket') ? tp.noFiltersTickets : tp.noFiltersConversations}
              </p>
            )}

            <div className="space-y-2">
              {filters.map((filter, index) => {
                const fieldDef = fieldDefs.find((fd) => fd.field === filter.field);
                const rowAvailableFields = fieldDefs.filter(
                  (fd) => fd.field === filter.field || !usedFields.has(fd.field),
                );

                return (
                  <div
                    key={index}
                    className="rounded-lg border bg-background p-2.5 space-y-2"
                  >
                    <div className="flex items-center gap-1.5">
                      {index > 0 && (
                        <span className="text-[10px] font-semibold text-orange-600 dark:text-orange-400 uppercase mr-0.5">
                          {tp.andOperator}
                        </span>
                      )}
                      {/* Field selector */}
                      <Select
                        value={filter.field}
                        onValueChange={(val) => {
                          const newFieldDef = fieldDefs.find((fd) => fd.field === val);
                          updateFilter(index, {
                            field: val,
                            operator: 'equals',
                            value: newFieldDef?.type === 'select' ? '' : '',
                          });
                        }}
                      >
                        <SelectTrigger className="h-7 text-xs flex-1 min-w-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {rowAvailableFields.map((fd) => (
                            <SelectItem key={fd.field} value={fd.field}>
                              {fd.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {/* Operator */}
                      <Select
                        value={filter.operator}
                        onValueChange={(val) => {
                          const patch: Partial<TriggerFilter> = { operator: val };
                          if (!needsValue(val)) patch.value = '';
                          updateFilter(index, patch);
                        }}
                      >
                        <SelectTrigger className="h-7 text-xs w-[130px] shrink-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {OPERATOR_OPTIONS.map((op) => (
                            <SelectItem key={op.value} value={op.value}>
                              {op.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {/* Delete */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 shrink-0 text-muted-foreground hover:text-red-600"
                        onClick={() => removeFilter(index)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>

                    {/* Value — only if operator needs it */}
                    {needsValue(filter.operator) && (
                      <div>
                        {fieldDef?.type === 'select' && fieldDef.options ? (
                          <Select
                            value={String(filter.value || '')}
                            onValueChange={(val) => updateFilter(index, { value: val })}
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue placeholder={tp.selectValuePlaceholder} />
                            </SelectTrigger>
                            <SelectContent>
                              {fieldDef.options.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            value={String(filter.value || '')}
                            onChange={(e) => updateFilter(index, { value: e.target.value })}
                            placeholder={tp.enterValuePlaceholder}
                            className="h-8 text-xs"
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Add filter button */}
            {availableFields.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-8 text-xs w-full"
                onClick={addFilter}
              >
                <Plus className="h-3 w-3 mr-1" />
                {tp.addFilter}
              </Button>
            )}
          </div>
        </div>
      </ScrollArea>
    </>
  );
}
