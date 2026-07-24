import { useState, useEffect } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Switch } from '@weldsuite/ui/components/switch';
import { Badge } from '@weldsuite/ui/components/badge';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@weldsuite/ui/components/collapsible';
import {
  Plus,
  GripVertical,
  X,
  ChevronDown,
  ChevronRight,
  ListFilter,
  EyeOff,
} from 'lucide-react';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import type {
  TicketTypeConfig,
  TicketTypeField,
  TicketTypeFieldCondition,
  TicketTypeStateGroup,
} from '@/hooks/queries/use-helpdesk-queries';

const FIELD_TYPES: { value: TicketTypeField['type']; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Text (multiline)' },
  { value: 'number', label: 'Number' },
  { value: 'email', label: 'Email' },
  { value: 'url', label: 'URL' },
  { value: 'select', label: 'Dropdown' },
  { value: 'multiselect', label: 'Multi-select' },
  { value: 'date', label: 'Date' },
  { value: 'checkbox', label: 'Checkbox' },
];

const CONDITION_OPERATORS: { value: TicketTypeFieldCondition['operator']; label: string }[] = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Does not equal' },
  { value: 'is_set', label: 'Is set' },
  { value: 'is_not_set', label: 'Is not set' },
];

const CATEGORY_OPTIONS = [
  { value: 'customer', label: 'Customer' },
  { value: 'back-office', label: 'Back-office' },
  { value: 'tracker', label: 'Tracker' },
];

const DEFAULT_STATES: TicketTypeStateGroup[] = [
  {
    groupKey: 'submitted',
    groupLabel: 'Submitted',
    customerGroupLabel: 'Submitted',
    states: [{ key: 'submitted', label: 'Submitted', customerLabel: 'Submitted' }],
  },
  {
    groupKey: 'in_progress',
    groupLabel: 'In Progress',
    customerGroupLabel: 'In progress',
    states: [{ key: 'in_progress', label: 'In Progress', customerLabel: 'In progress' }],
  },
  {
    groupKey: 'waiting_on_customer',
    groupLabel: 'Waiting on Customer',
    customerGroupLabel: 'Waiting on you',
    states: [{ key: 'waiting_on_customer', label: 'Waiting on Customer', customerLabel: 'Waiting on you' }],
  },
  {
    groupKey: 'resolved',
    groupLabel: 'Resolved',
    customerGroupLabel: 'Resolved',
    states: [{ key: 'resolved', label: 'Resolved', customerLabel: 'Resolved' }],
  },
];

const DEFAULT_FIELDS: TicketTypeField[] = [
  {
    key: 'title',
    label: 'Title',
    type: 'text',
    required: true,
    order: 0,
    isDefault: true,
    teammateVisible: true,
    customerVisible: true,
  },
  {
    key: 'description',
    label: 'Description',
    type: 'textarea',
    required: false,
    order: 1,
    isDefault: true,
    teammateVisible: true,
    customerVisible: true,
  },
];

interface TicketTypeEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingType: TicketTypeConfig | null;
  onSave: (type: TicketTypeConfig) => void;
}

function generateFieldKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// Section header component for the collapsible sections
function SectionHeader({
  title,
  count,
  isOpen,
}: {
  title: string;
  count?: number;
  isOpen: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-3 px-1 cursor-pointer select-none hover:bg-muted/50 rounded-md -mx-1">
      {isOpen ? (
        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
      ) : (
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
      )}
      <span className="font-semibold text-sm uppercase tracking-wide">{title}</span>
      {count !== undefined && (
        <Badge variant="secondary" className="text-xs ml-1">
          {count}
        </Badge>
      )}
    </div>
  );
}

export function TicketTypeEditor({ open, onOpenChange, editingType, onSave }: TicketTypeEditorProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const tte = t.helpdesk.ticketTypeEditor;
  const isEditing = !!editingType;

  // Basic info
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Intercom-style fields
  const [category, setCategory] = useState('customer');
  const [disableAiAutofill, setDisableAiAutofill] = useState(false);
  const [states, setStates] = useState<TicketTypeStateGroup[]>(DEFAULT_STATES);
  const [fields, setFields] = useState<TicketTypeField[]>(DEFAULT_FIELDS);

  // Section open state
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [statesOpen, setStatesOpen] = useState(false);
  const [attributesOpen, setAttributesOpen] = useState(false);
  const [editingState, setEditingState] = useState<{ groupIndex: number; stateIndex: number } | null>(null);
  const [expandedFieldIndex, setExpandedFieldIndex] = useState<number | null>(null);

  useEffect(() => {
    if (editingType) {
      setName(editingType.name);
      setDescription(editingType.description || '');
      setCategory(editingType.category || 'customer');
      setDisableAiAutofill(editingType.disableAiAutofill || false);
      setStates(editingType.states && editingType.states.length > 0 ? editingType.states : DEFAULT_STATES);
      setFields(editingType.fields && editingType.fields.length > 0 ? editingType.fields : DEFAULT_FIELDS);
    } else {
      setName('');
      setDescription('');
      setCategory('customer');
      setDisableAiAutofill(false);
      setStates(DEFAULT_STATES);
      setFields(DEFAULT_FIELDS);
    }
    setDetailsOpen(true);
    setStatesOpen(false);
    setAttributesOpen(false);
    setEditingState(null);
    setExpandedFieldIndex(null);
  }, [editingType, open]);

  // ===== Field handlers =====
  const handleAddField = () => {
    const newField: TicketTypeField = {
      key: `field_${Date.now()}`,
      label: '',
      type: 'text',
      required: false,
      order: fields.length,
      isDefault: false,
      teammateVisible: true,
      customerVisible: true,
    };
    setFields([...fields, newField]);
    setExpandedFieldIndex(fields.length);
  };

  const handleUpdateField = (index: number, updates: Partial<TicketTypeField>) => {
    setFields(fields.map((f, i) => {
      if (i !== index) return f;
      const updated = { ...f, ...updates };
      if (updates.label && !f.isDefault) {
        updated.key = generateFieldKey(updates.label);
      }
      return updated;
    }));
  };

  const handleRemoveField = (index: number) => {
    if (fields[index]?.isDefault) return;
    if (expandedFieldIndex === index) setExpandedFieldIndex(null);
    else if (expandedFieldIndex !== null && expandedFieldIndex > index) setExpandedFieldIndex(expandedFieldIndex - 1);
    setFields(fields.filter((_, i) => i !== index).map((f, i) => ({ ...f, order: i })));
  };

  const handleAddOption = (fieldIndex: number) => {
    setFields(fields.map((f, i) => {
      if (i !== fieldIndex) return f;
      const options = f.options || [];
      return { ...f, options: [...options, { label: '', value: '' }] };
    }));
  };

  const handleUpdateOption = (fieldIndex: number, optionIndex: number, label: string) => {
    setFields(fields.map((f, i) => {
      if (i !== fieldIndex) return f;
      const options = [...(f.options || [])];
      options[optionIndex] = {
        label,
        value: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      };
      return { ...f, options };
    }));
  };

  const handleRemoveOption = (fieldIndex: number, optionIndex: number) => {
    setFields(fields.map((f, i) => {
      if (i !== fieldIndex) return f;
      return { ...f, options: (f.options || []).filter((_, oi) => oi !== optionIndex) };
    }));
  };

  // ===== Condition handlers =====
  const handleAddCondition = (fieldIndex: number) => {
    setFields(fields.map((f, i) => {
      if (i !== fieldIndex) return f;
      const conditions = f.conditions || [];
      return { ...f, conditions: [...conditions, { field: '', operator: 'equals' as const, value: '' }] };
    }));
  };

  const handleUpdateCondition = (fieldIndex: number, condIndex: number, updates: Partial<TicketTypeFieldCondition>) => {
    setFields(fields.map((f, i) => {
      if (i !== fieldIndex) return f;
      const conditions = [...(f.conditions || [])];
      conditions[condIndex] = { ...conditions[condIndex], ...updates };
      return { ...f, conditions };
    }));
  };

  const handleRemoveCondition = (fieldIndex: number, condIndex: number) => {
    setFields(fields.map((f, i) => {
      if (i !== fieldIndex) return f;
      return { ...f, conditions: (f.conditions || []).filter((_, ci) => ci !== condIndex) };
    }));
  };

  // ===== Submit =====
  const handleSubmit = () => {
    if (!name.trim()) {
      toast.error(t.helpdesk.ticketTypesSettings.nameRequired);
      return;
    }

    for (const field of fields) {
      if (!field.isDefault && !field.label.trim()) {
        toast.error(t.helpdesk.ticketTypesSettings.allAttributesMustHaveName);
        return;
      }
      if ((field.type === 'select' || field.type === 'multiselect') && (!field.options || field.options.length === 0)) {
        toast.error(t.helpdesk.ticketTypesSettings.attributeNeedsOption.replace('{name}', field.label));
        return;
      }
    }

    for (const group of states) {
      for (const state of group.states) {
        if (!state.label.trim()) {
          toast.error(t.helpdesk.ticketTypesSettings.allStatesInGroupMustHaveName.replace('{group}', group.groupLabel));
          return;
        }
      }
    }

    const now = new Date().toISOString();
    const savedType: TicketTypeConfig = {
      id: editingType?.id || `ttype_${Date.now()}`,
      name,
      description: description || undefined,
      category,
      disableAiAutofill,
      fields: fields.map((f, i) => ({ ...f, order: i, key: f.key || generateFieldKey(f.label) })),
      states,
      sortOrder: editingType?.sortOrder ?? 0,
      isActive: true,
      createdAt: editingType?.createdAt || now,
      updatedAt: now,
    };

    onSave(savedType);
    toast.success(isEditing ? tte.ticketTypeUpdated : tte.ticketTypeCreated);
    onOpenChange(false);
  };

  const totalStates = states.reduce((sum, g) => sum + g.states.length, 0);
  const totalAttributes = fields.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl !grid-rows-[auto_1fr_auto] max-h-[85vh] overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>{isEditing ? tte.editTitle : tte.createTitle}</DialogTitle>
        </DialogHeader>

        <ScrollArea className="h-full">
        <div className="space-y-1 py-2 px-6">
          {/* Basic info - always visible at top */}
          <div className="space-y-4 pb-4 border-b">
            <div className="space-y-2">
              <Label>{tte.nameRequired}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tte.namePlaceholder}
              />
            </div>
          </div>

          {/* ====== DETAILS Section ====== */}
          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
            <CollapsibleTrigger asChild>
              <div>
                <SectionHeader title={tte.detailsSection} isOpen={detailsOpen} />
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-4 pb-4 pl-6">
                {/* Ticket Category */}
                <div className="space-y-2">
                  <Label>{tte.ticketCategory}</Label>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger className="w-full sm:w-60">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORY_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {tte.categoryDesc}
                  </p>
                </div>

                {/* Ticket Description */}
                <div className="space-y-2">
                  <Label>{tte.ticketDescription}</Label>
                  <Textarea
                    value={description}
                    onChange={(e) => {
                      if (e.target.value.length <= 255) {
                        setDescription(e.target.value);
                      }
                    }}
                    placeholder={tte.descriptionPlaceholder}
                    rows={3}
                  />
                  <p className="text-xs text-muted-foreground">
                    {tte.characterCount.replace('{count}', String(description.length))}
                  </p>
                </div>

                {/* Ticket sharing */}
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-sm text-muted-foreground">
                    {category === 'back-office'
                      ? tte.categoryBack
                      : category === 'tracker'
                        ? tte.categoryTracker
                        : tte.categoryCustomer}
                  </p>
                </div>

                {/* AI Autofill */}
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="disable-ai-autofill"
                    checked={disableAiAutofill}
                    onCheckedChange={(checked) => setDisableAiAutofill(checked === true)}
                  />
                  <div style={{ marginTop: 1 }}>
                    <Label htmlFor="disable-ai-autofill" className="cursor-pointer">
                      {tte.disableAiAutofill}
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1.5">
                      {tte.disableAiAutofillDesc}
                    </p>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="border-b" />

          {/* ====== STATES Section ====== */}
          <Collapsible open={statesOpen} onOpenChange={setStatesOpen}>
            <CollapsibleTrigger asChild>
              <div>
                <SectionHeader title={tte.statesSection} count={totalStates} isOpen={statesOpen} />
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pb-4 pl-6 space-y-5">
                {states.map((group, groupIndex) => (
                  <div key={group.groupKey} className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.groupLabel}
                    </p>
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-1.5">
                        {group.states.map((state, stateIndex) => (
                          <div
                            key={state.key || stateIndex}
                            className={cn(
                              'group inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 cursor-pointer transition-colors',
                              editingState?.groupIndex === groupIndex && editingState?.stateIndex === stateIndex
                                ? 'border-primary bg-primary/5'
                                : 'hover:border-foreground/30'
                            )}
                            onClick={() => setEditingState({ groupIndex, stateIndex })}
                          >
                            <span className="text-xs font-medium">{state.label || tte.untitledState}</span>
                            <span className="text-muted-foreground text-xs">&bull;</span>
                            <span className="text-xs text-muted-foreground">
                              {tte.customerSees} &ldquo;{state.customerLabel || '...'}&rdquo;
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive ml-0.5"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (editingState?.groupIndex === groupIndex && editingState?.stateIndex === stateIndex) {
                                  setEditingState(null);
                                }
                                setStates(states.map((g, gi) => {
                                  if (gi !== groupIndex) return g;
                                  return { ...g, states: g.states.filter((_, si) => si !== stateIndex) };
                                }));
                              }}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="ghost"
                          className="inline-flex items-center gap-1 rounded-md border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                          onClick={() => {
                            const newIndex = group.states.length;
                            setStates(states.map((g, i) => {
                              if (i !== groupIndex) return g;
                              return {
                                ...g,
                                states: [...g.states, {
                                  key: `state_${Date.now()}`,
                                  label: '',
                                  customerLabel: '',
                                }],
                              };
                            }));
                            setEditingState({ groupIndex, stateIndex: newIndex });
                          }}
                        >
                          <Plus className="h-3 w-3" />
                          {tte.addState}
                        </Button>
                      </div>

                      {/* Inline edit card */}
                      {editingState?.groupIndex === groupIndex && group.states[editingState.stateIndex] && (
                        <div
                          className="rounded-lg border bg-card p-3 space-y-3 animate-in fade-in-0 slide-in-from-top-1 duration-150"
                          onBlur={(e) => {
                            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                              setEditingState(null);
                            }
                          }}
                        >
                          <div className="flex items-end gap-3">
                            <div className="flex-1 space-y-1">
                              <Label className="text-xs text-muted-foreground">{tte.stateName}</Label>
                              <Input
                                value={group.states[editingState.stateIndex].label}
                                onChange={(e) => {
                                  const si = editingState.stateIndex;
                                  setStates(states.map((g, gi) => {
                                    if (gi !== groupIndex) return g;
                                    return { ...g, states: g.states.map((s, i) => i !== si ? s : { ...s, label: e.target.value, key: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') }) };
                                  }));
                                }}
                                placeholder={tte.stateNamePlaceholder}
                                className="h-8 text-sm"
                                autoFocus
                                onKeyDown={(e) => { if (e.key === 'Enter') setEditingState(null); }}
                              />
                            </div>
                            <div className="flex-1 space-y-1">
                              <Label className="text-xs text-muted-foreground">{tte.customerSees}</Label>
                              <Input
                                value={group.states[editingState.stateIndex].customerLabel}
                                onChange={(e) => {
                                  const si = editingState.stateIndex;
                                  setStates(states.map((g, gi) => {
                                    if (gi !== groupIndex) return g;
                                    return { ...g, states: g.states.map((s, i) => i !== si ? s : { ...s, customerLabel: e.target.value }) };
                                  }));
                                }}
                                placeholder={tte.customerSeesPlaceholder}
                                className="h-8 text-sm"
                                onKeyDown={(e) => { if (e.key === 'Enter') setEditingState(null); }}
                              />
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              className="h-8 text-xs shrink-0"
                              onClick={() => setEditingState(null)}
                            >
                              {tte.done}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="border-b" />

          {/* ====== ATTRIBUTES Section ====== */}
          <Collapsible open={attributesOpen} onOpenChange={setAttributesOpen}>
            <CollapsibleTrigger asChild>
              <div>
                <SectionHeader title={tte.attributesSection} count={totalAttributes} isOpen={attributesOpen} />
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pb-4 pl-6 space-y-1.5">
                {fields.map((field, index) => {
                  const isExpanded = expandedFieldIndex === index;
                  const conditionCount = field.conditions?.length || 0;
                  const fieldTypeLabel = FIELD_TYPES.find((ft) => ft.value === field.type)?.label || field.type;

                  // ── Default attribute row (non-expandable) ──
                  if (field.isDefault) {
                    return (
                      <div
                        key={field.key}
                        className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2.5"
                      >
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span className="text-sm font-medium truncate">{field.label}</span>
                          <Badge variant="secondary" className="text-[10px] shrink-0">{tte.defaultBadge}</Badge>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">{fieldTypeLabel}</span>
                      </div>
                    );
                  }

                  // ── Custom attribute row (expandable) ──
                  return (
                    <div
                      key={field.key || index}
                      className={cn(
                        'rounded-lg border transition-colors',
                        isExpanded ? 'border-primary/30 bg-primary/[0.02]' : 'hover:border-foreground/20'
                      )}
                    >
                      {/* Collapsed summary row */}
                      <div
                        className="flex items-center gap-2 px-3 py-2.5 cursor-pointer"
                        onClick={() => setExpandedFieldIndex(isExpanded ? null : index)}
                      >
                        <GripVertical className="h-3.5 w-3.5 text-muted-foreground/50 cursor-grab shrink-0" />
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span className={cn('text-sm font-medium truncate', !field.label && 'text-muted-foreground italic')}>
                            {field.label || tte.untitledAttribute}
                          </span>
                          {field.required && (
                            <span className="text-[10px] text-destructive font-medium shrink-0">{tte.required}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Badge variant="outline" className="text-[10px] font-normal">
                            {fieldTypeLabel}
                          </Badge>
                          {conditionCount > 0 && (
                            <Badge variant="outline" className="text-[10px] font-normal gap-0.5">
                              <ListFilter className="h-2.5 w-2.5" />
                              {conditionCount}
                            </Badge>
                          )}
                          {field.teammateVisible === false && (
                            <EyeOff className="h-3 w-3 text-muted-foreground/50" />
                          )}
                        </div>
                      </div>

                      {/* Expanded editor */}
                      {isExpanded && (
                        <div className="px-3 pb-3 space-y-4 animate-in fade-in-0 slide-in-from-top-1 duration-150">
                          <div className="border-t pt-3" />

                          {/* Row 1: Name + Type */}
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                              <Label className="text-xs">{tte.nameFieldLabel}</Label>
                              <Input
                                value={field.label}
                                onChange={(e) => handleUpdateField(index, { label: e.target.value })}
                                placeholder={st('sweep.welddesk.ticketTypeEditor.fieldNamePlaceholder')}
                                className="h-8 text-sm"
                                autoFocus
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">{tte.typeFieldLabel}</Label>
                              <Select
                                value={field.type}
                                onValueChange={(value) => handleUpdateField(index, { type: value as TicketTypeField['type'] })}
                              >
                                <SelectTrigger className="h-8 text-sm">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {FIELD_TYPES.map((ft) => (
                                    <SelectItem key={ft.value} value={ft.value}>{ft.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>

                          {/* Row 2: Placeholder + Required */}
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                              <Label className="text-xs">{tte.placeholder}</Label>
                              <Input
                                value={field.placeholder || ''}
                                onChange={(e) => handleUpdateField(index, { placeholder: e.target.value })}
                                placeholder={tte.placeholderHint}
                                className="h-8 text-sm"
                              />
                            </div>
                            <div className="flex items-end pb-1">
                              <div className="flex items-center gap-2">
                                <Switch
                                  id={`required-${field.key}`}
                                  checked={field.required}
                                  onCheckedChange={(checked) => handleUpdateField(index, { required: checked })}
                                />
                                <Label htmlFor={`required-${field.key}`} className="text-xs cursor-pointer">{tte.required}</Label>
                              </div>
                            </div>
                          </div>

                          {/* Options (for select/multiselect) */}
                          {(field.type === 'select' || field.type === 'multiselect') && (
                            <div className="space-y-2">
                              <Label className="text-xs">{tte.options}</Label>
                              <div className="space-y-1.5">
                                {(field.options || []).map((option, optIndex) => (
                                  <div key={optIndex} className="flex items-center gap-2">
                                    <div className="w-5 text-center">
                                      <span className="text-[10px] text-muted-foreground">{optIndex + 1}</span>
                                    </div>
                                    <Input
                                      value={option.label}
                                      onChange={(e) => handleUpdateOption(index, optIndex, e.target.value)}
                                      placeholder={`Option ${optIndex + 1}`}
                                      className="h-7 text-sm flex-1"
                                    />
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="text-muted-foreground/50 hover:text-destructive transition-colors shrink-0"
                                      onClick={() => handleRemoveOption(index, optIndex)}
                                    >
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </div>
                                ))}
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                                onClick={() => handleAddOption(index)}
                              >
                                <Plus className="h-3 w-3" />
                                {tte.addOption}
                              </Button>
                            </div>
                          )}

                          {/* Visibility */}
                          <div className="space-y-2">
                            <Label className="text-xs">{tte.visibility}</Label>
                            <div className="flex items-center gap-4">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <Checkbox
                                  checked={field.teammateVisible !== false}
                                  onCheckedChange={(checked) => handleUpdateField(index, { teammateVisible: checked === true })}
                                />
                                <span className="text-xs">{tte.teammates}</span>
                              </label>
                              <label className="flex items-center gap-2 cursor-pointer">
                                <Checkbox
                                  checked={field.customerVisible !== false}
                                  onCheckedChange={(checked) => handleUpdateField(index, { customerVisible: checked === true })}
                                />
                                <span className="text-xs">{tte.customers}</span>
                              </label>
                            </div>
                          </div>

                          {/* Conditions */}
                          <div className="space-y-2">
                            <Label className="text-xs">{tte.conditions}</Label>
                            {(field.conditions || []).length === 0 ? (
                              <p className="text-xs text-muted-foreground">
                                {tte.noConditions}
                              </p>
                            ) : (
                              <div className="space-y-1.5">
                                {(field.conditions || []).map((condition, condIndex) => (
                                  <div key={condIndex} className="flex items-center gap-2">
                                    {condIndex > 0 && (
                                      <span className="text-[10px] font-medium text-muted-foreground uppercase w-6 text-center shrink-0">{st('sweep.welddesk.ticketTypeEditor.conditionAnd')}</span>
                                    )}
                                    <Select
                                      value={condition.field}
                                      onValueChange={(val) => handleUpdateCondition(index, condIndex, { field: val })}
                                    >
                                      <SelectTrigger className="h-7 text-xs flex-1">
                                        <SelectValue placeholder={st('sweep.welddesk.ticketTypeEditor.conditionFieldPlaceholder')} />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {fields
                                          .filter((f) => f.key !== field.key)
                                          .map((f) => (
                                            <SelectItem key={f.key} value={f.key}>{f.label || f.key}</SelectItem>
                                          ))
                                        }
                                      </SelectContent>
                                    </Select>
                                    <Select
                                      value={condition.operator}
                                      onValueChange={(val) => handleUpdateCondition(index, condIndex, { operator: val as TicketTypeFieldCondition['operator'] })}
                                    >
                                      <SelectTrigger className="h-7 text-xs w-[120px]">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {CONDITION_OPERATORS.map((op) => (
                                          <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    {condition.operator !== 'is_set' && condition.operator !== 'is_not_set' && (
                                      (() => {
                                        const targetField = fields.find((f) => f.key === condition.field);
                                        if (targetField && (targetField.type === 'select' || targetField.type === 'multiselect') && targetField.options?.length) {
                                          return (
                                            <Select
                                              value={condition.value || ''}
                                              onValueChange={(val) => handleUpdateCondition(index, condIndex, { value: val })}
                                            >
                                              <SelectTrigger className="h-7 text-xs flex-1">
                                                <SelectValue placeholder={st('sweep.welddesk.ticketTypeEditor.conditionValuePlaceholder')} />
                                              </SelectTrigger>
                                              <SelectContent>
                                                {targetField.options.map((opt) => (
                                                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                          );
                                        }
                                        return (
                                          <Input
                                            value={condition.value || ''}
                                            onChange={(e) => handleUpdateCondition(index, condIndex, { value: e.target.value })}
                                            placeholder={st('sweep.welddesk.ticketTypeEditor.conditionValuePlaceholder')}
                                            className="h-7 text-xs flex-1"
                                          />
                                        );
                                      })()
                                    )}
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="text-muted-foreground/50 hover:text-destructive transition-colors shrink-0"
                                      onClick={() => handleRemoveCondition(index, condIndex)}
                                    >
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                              onClick={() => handleAddCondition(index)}
                            >
                              <Plus className="h-3 w-3" />
                              {tte.addCondition}
                            </Button>
                          </div>

                          {/* Cancel + Done buttons */}
                          <div className="flex justify-end gap-2 pt-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => {
                                handleRemoveField(index);
                              }}
                            >
                              {tte.cancel}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => setExpandedFieldIndex(null)}
                            >
                              {tte.done}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Add attribute */}
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-dashed py-2.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                  onClick={handleAddField}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {tte.addAttribute}
                </Button>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        </ScrollArea>

        <DialogFooter className="px-6 pb-6 pt-4 border-t gap-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tte.cancel}
          </Button>
          <Button onClick={handleSubmit}>
            {isEditing ? tte.update : tte.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
