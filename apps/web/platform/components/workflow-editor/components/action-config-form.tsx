
import { useState, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useCustomFields } from '@/hooks/use-custom-fields';
import { AiUnavailable } from '@/components/ai/ai-unavailable';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Button } from '@weldsuite/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Slider } from '@weldsuite/ui/components/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Badge } from '@weldsuite/ui/components/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  Info,
  Plus,
  X,
  ChevronsUpDown,
  Check,
  GripVertical,
  Bot,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import { VariableInput } from '@weldsuite/ui/components/workflow-canvas/parts/variable-input';
import type { VariableGroup } from '@weldsuite/ui/components/workflow-canvas/parts/variable-picker';
import { EntityTypeSelect } from '@weldsuite/ui/components/workflow-canvas/parts/entity-type-select';
import { FieldBuilder } from '@weldsuite/ui/components/workflow-canvas/parts/field-builder';
import { FilterBuilder, type FilterCondition } from '@weldsuite/ui/components/workflow-canvas/parts/filter-builder';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

// Types for context data
interface EmailAccountOption {
  id: string;
  email: string;
  displayName?: string;
}

interface WorkflowStep {
  id: string;
  name: string;
  type: string;
}

interface WorkflowVariable {
  name: string;
  type?: string;
}

interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  avatar?: string;
}

interface ActionConfigFormProps {
  actionType: string;
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
  // Context data for enhanced forms
  emailAccounts?: EmailAccountOption[];
  workspaceMembers?: WorkspaceMember[];
  workflowSteps?: WorkflowStep[];
  currentStepIndex?: number;
  workflowVariables?: WorkflowVariable[];
  triggerType?: string;
  extraVariableGroups?: VariableGroup[];
  excludeGroups?: string[];
}

// Field wrapper with label and description
function FormField({
  label,
  description,
  required,
  children,
}: {
  label: string;
  description?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1">
        {label}
        {required && <span className="text-red-500">*</span>}
        {description && (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="ml-1 text-muted-foreground hover:text-foreground">
                  <Info className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[200px]">
                <p className="text-xs">{description}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </Label>
      {children}
    </div>
  );
}

// ============================================================================
// Set Attribute Form — set_contact_attribute / set_conversation_attribute
//
// Replaces the raw-JSON fallback for these two steps with a picker over the
// custom field definitions for the entity (plus, for contacts, the built-in
// direct fields the handler maps to real `people` columns). Stores
// `config.attribute` = slug/field name and `config.value`.
// ============================================================================

/** Built-in contact fields the set_contact_attribute handler writes to real
 *  people columns (must mirror DIRECT_FIELDS in the worker handler). */
const CONTACT_DIRECT_FIELDS = ['firstName', 'lastName', 'fullName', 'email', 'phone', 'company'];

function SetAttributeForm({
  config,
  onChange,
  entityType,
  acf,
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  entityType: 'person' | 'conversation';
  acf: any;
}) {
  const { data: definitions = [], isLoading } = useCustomFields(entityType);
  const current: string = config.attribute ?? '';

  // Options: built-in direct fields (contacts only) + custom field slugs. If the
  // saved step carries an attribute not in either list (a legacy free-text
  // value), surface it too so it stays selected and visible.
  const directFields = entityType === 'person' ? CONTACT_DIRECT_FIELDS : [];
  const defSlugs = definitions.map((d) => d.slug);
  const known = new Set<string>([...directFields, ...defSlugs]);
  const legacy = current && !known.has(current) ? [current] : [];

  const selectedDef = definitions.find((d) => d.slug === current);

  return (
    <>
      <FormField label={acf.attribute} required description={acf.attributeDesc}>
        <Select
          value={current || undefined}
          onValueChange={(value) => onChange({ ...config, attribute: value })}
        >
          <SelectTrigger>
            <SelectValue placeholder={isLoading ? acf.loading : acf.selectAttribute} />
          </SelectTrigger>
          <SelectContent>
            {directFields.length > 0 &&
              directFields.map((f) => (
                <SelectItem key={`direct:${f}`} value={f}>
                  {f}
                </SelectItem>
              ))}
            {definitions.map((d) => (
              <SelectItem key={d.id} value={d.slug}>
                {d.name}
              </SelectItem>
            ))}
            {legacy.map((v) => (
              <SelectItem key={`legacy:${v}`} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!isLoading && definitions.length === 0 && directFields.length === 0 && (
          <p className="text-xs text-muted-foreground">{acf.noAttributeDefinitions}</p>
        )}
      </FormField>

      <FormField label={acf.attributeValue} description={acf.attributeValueDesc}>
        {selectedDef?.fieldType === 'boolean' ? (
          <Select
            value={String(config.value ?? '')}
            onValueChange={(value) => onChange({ ...config, value: value === 'true' })}
          >
            <SelectTrigger>
              <SelectValue placeholder={acf.selectValue} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">true</SelectItem>
              <SelectItem value="false">false</SelectItem>
            </SelectContent>
          </Select>
        ) : selectedDef?.fieldType === 'single_select' && (selectedDef.options?.length ?? 0) > 0 ? (
          <Select
            value={config.value ?? undefined}
            onValueChange={(value) => onChange({ ...config, value })}
          >
            <SelectTrigger>
              <SelectValue placeholder={acf.selectValue} />
            </SelectTrigger>
            <SelectContent>
              {selectedDef.options!.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={config.value ?? ''}
            onChange={(e) => onChange({ ...config, value: e.target.value })}
            placeholder={acf.attributeValuePlaceholder}
          />
        )}
      </FormField>
    </>
  );
}

// ============================================================================
// Send Email Form - With email account dropdown
// ============================================================================
function SendEmailForm({
  config,
  onChange,
  emailAccounts = [],
  triggerType,
  steps = [],
  workflowVariables = [],
  extraVariableGroups,
  excludeGroups,
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  emailAccounts?: EmailAccountOption[];
  triggerType?: string;
  steps?: WorkflowStep[];
  workflowVariables?: WorkflowVariable[];
  extraVariableGroups?: VariableGroup[];
  excludeGroups?: string[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  const htmlBodyRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const wrapSelection = useCallback((tag: string, attr?: string) => {
    const el = htmlBodyRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const text = config.body || '';
    const selected = text.substring(start, end);
    const openTag = attr ? `<${tag} ${attr}>` : `<${tag}>`;
    const closeTag = `</${tag}>`;
    const wrapped = `${openTag}${selected}${closeTag}`;
    const newValue = text.substring(0, start) + wrapped + text.substring(end);
    onChange({ ...config, body: newValue, isHtml: true });
    requestAnimationFrame(() => {
      el.focus();
      const cursorPos = start + wrapped.length;
      el.setSelectionRange(cursorPos, cursorPos);
    });
  }, [config, onChange]);

  const insertAtCursor = useCallback((html: string) => {
    const el = htmlBodyRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const text = config.body || '';
    const newValue = text.substring(0, start) + html + text.substring(start);
    onChange({ ...config, body: newValue, isHtml: true });
    requestAnimationFrame(() => {
      el.focus();
      const cursorPos = start + html.length;
      el.setSelectionRange(cursorPos, cursorPos);
    });
  }, [config, onChange]);

  return (
    <div className="space-y-4">
      <FormField label={acf.fromAccount} description={acf.fromAccountDesc}>
        <Select
          value={config.from || '__default__'}
          onValueChange={(value) => onChange({ ...config, from: value === '__default__' ? undefined : value })}
        >
          <SelectTrigger>
            <SelectValue placeholder={acf.useDefaultAccount} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">{acf.useDefaultAccount}</SelectItem>
            {emailAccounts.map((acc) => (
              <SelectItem key={acc.id} value={acc.id}>
                {acc.displayName ? `${acc.displayName} (${acc.email})` : acc.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <FormField label={acf.to} required>
        <VariableInput
          value={config.to || ''}
          onChange={(v) => onChange({ ...config, to: v })}
          placeholder={st('sweep.weldflow.actionConfig.recipientEmailPlaceholder')}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
          extraVariableGroups={extraVariableGroups}
          excludeGroups={excludeGroups}
        />
      </FormField>

      <FormField label={acf.subject} required>
        <VariableInput
          value={config.subject || ''}
          onChange={(v) => onChange({ ...config, subject: v })}
          placeholder={st('sweep.weldflow.actionConfig.emailSubjectPlaceholder')}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
          extraVariableGroups={extraVariableGroups}
          excludeGroups={excludeGroups}
        />
      </FormField>

      <FormField label={acf.body} required>
        <Tabs defaultValue="html" className="w-full">
          <TabsList className="h-8">
            <TabsTrigger value="html" className="text-xs h-7">{st('sweep.weldflow.actionConfig.htmlTab')}</TabsTrigger>
            <TabsTrigger value="plain" className="text-xs h-7">{st('sweep.weldflow.actionConfig.plainTextTab')}</TabsTrigger>
          </TabsList>
          <TabsContent value="html" className="mt-2">
            <div className="rounded-md border border-input overflow-hidden">
              <VariableInput
                value={config.body || ''}
                onChange={(v) => onChange({ ...config, body: v, isHtml: true })}
                placeholder={st('sweep.weldflow.actionConfig.emailHtmlBodyPlaceholder')}
                multiline
                rows={6}
                className="border-0 rounded-none focus-visible:ring-0 focus-visible:ring-offset-0"
                triggerType={triggerType}
                steps={steps}
                workflowVariables={workflowVariables}
                extraVariableGroups={extraVariableGroups}
                excludeGroups={excludeGroups}
                inputRef={htmlBodyRef}
              />
              <div className="px-3 py-2 border-t border-border flex items-center gap-1 bg-background">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => wrapSelection('strong')}
                  onMouseDown={(e) => e.preventDefault()}
                  className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md"
                  title={st('sweep.weldflow.actionConfig.bold')}
                >
                  <svg className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
                    <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
                  </svg>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => wrapSelection('em')}
                  onMouseDown={(e) => e.preventDefault()}
                  className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md"
                  title={st('sweep.weldflow.actionConfig.italic')}
                >
                  <svg className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="19" y1="4" x2="10" y2="4" />
                    <line x1="14" y1="20" x2="5" y2="20" />
                    <line x1="15" y1="4" x2="9" y2="20" />
                  </svg>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => wrapSelection('u')}
                  onMouseDown={(e) => e.preventDefault()}
                  className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md"
                  title={st('sweep.weldflow.actionConfig.underline')}
                >
                  <svg className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3" />
                    <line x1="4" y1="21" x2="20" y2="21" />
                  </svg>
                </Button>
                <div className="w-px h-4 bg-gray-200 dark:bg-border mx-1" />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => insertAtCursor('<ul>\n  <li></li>\n</ul>')}
                  onMouseDown={(e) => e.preventDefault()}
                  className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md"
                  title={st('sweep.weldflow.actionConfig.bulletList')}
                >
                  <svg className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="8" y1="6" x2="21" y2="6" />
                    <line x1="8" y1="12" x2="21" y2="12" />
                    <line x1="8" y1="18" x2="21" y2="18" />
                    <circle cx="4" cy="6" r="1" fill="currentColor" />
                    <circle cx="4" cy="12" r="1" fill="currentColor" />
                    <circle cx="4" cy="18" r="1" fill="currentColor" />
                  </svg>
                </Button>
                <div className="w-px h-4 bg-gray-200 dark:bg-border mx-1" />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    const url = prompt(st('sweep.weldflow.actionConfig.enterUrlPrompt'));
                    if (url) wrapSelection('a', `href="${url}"`);
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-md"
                  title={st('sweep.weldflow.actionConfig.insertLink')}
                >
                  <svg className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                </Button>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="plain" className="mt-2">
            <VariableInput
              value={config.body || ''}
              onChange={(v) => onChange({ ...config, body: v, isHtml: false })}
              placeholder={st('sweep.weldflow.actionConfig.emailPlainBodyPlaceholder')}
              multiline
              rows={6}
              triggerType={triggerType}
              steps={steps}
              workflowVariables={workflowVariables}
              extraVariableGroups={extraVariableGroups}
              excludeGroups={excludeGroups}
            />
          </TabsContent>
        </Tabs>
      </FormField>

      <FormField label={acf.cc}>
        <VariableInput
          value={config.cc || ''}
          onChange={(v) => onChange({ ...config, cc: v })}
          placeholder={st('sweep.weldflow.actionConfig.ccPlaceholder')}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
          extraVariableGroups={extraVariableGroups}
          excludeGroups={excludeGroups}
        />
      </FormField>

      <FormField label={acf.bcc}>
        <VariableInput
          value={config.bcc || ''}
          onChange={(v) => onChange({ ...config, bcc: v })}
          placeholder={st('sweep.weldflow.actionConfig.bccPlaceholder')}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
          extraVariableGroups={extraVariableGroups}
          excludeGroups={excludeGroups}
        />
      </FormField>
    </div>
  );
}

// ============================================================================
// HTTP Request Form
// ============================================================================
function HttpRequestForm({
  config,
  onChange,
  triggerType,
  steps = [],
  workflowVariables = [],
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  triggerType?: string;
  steps?: WorkflowStep[];
  workflowVariables?: WorkflowVariable[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>(
    config.headers ? Object.entries(config.headers).map(([key, value]) => ({ key, value: String(value) })) : []
  );

  const updateHeaders = (newHeaders: Array<{ key: string; value: string }>) => {
    setHeaders(newHeaders);
    const headersObj = newHeaders.reduce((acc, h) => {
      if (h.key) acc[h.key] = h.value;
      return acc;
    }, {} as Record<string, string>);
    onChange({ ...config, headers: headersObj });
  };

  return (
    <div className="space-y-4">
      <FormField label={acf.url} required>
        <VariableInput
          value={config.url || ''}
          onChange={(v) => onChange({ ...config, url: v })}
          placeholder={st('sweep.weldflow.actionConfig.httpUrlPlaceholder')}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
        />
      </FormField>

      <FormField label={acf.method} required>
        <Select
          value={config.method || 'GET'}
          onValueChange={(value) => onChange({ ...config, method: value })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="GET">GET</SelectItem>
            <SelectItem value="POST">POST</SelectItem>
            <SelectItem value="PUT">PUT</SelectItem>
            <SelectItem value="PATCH">PATCH</SelectItem>
            <SelectItem value="DELETE">DELETE</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      <FormField label={acf.headers}>
        <div className="space-y-2">
          {headers.map((header, index) => (
            <div key={index} className="flex gap-2">
              <Input
                value={header.key}
                onChange={(e) => {
                  const newHeaders = [...headers];
                  newHeaders[index].key = e.target.value;
                  updateHeaders(newHeaders);
                }}
                placeholder={acf.headerName}
                className="flex-1"
              />
              <Input
                value={header.value}
                onChange={(e) => {
                  const newHeaders = [...headers];
                  newHeaders[index].value = e.target.value;
                  updateHeaders(newHeaders);
                }}
                placeholder={acf.headerValue}
                className="flex-1"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => updateHeaders(headers.filter((_, i) => i !== index))}
                className="h-9 px-2"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => updateHeaders([...headers, { key: '', value: '' }])}
            className="w-full"
          >
            <Plus className="h-4 w-4 mr-0.5" />
            {acf.addHeader}
          </Button>
        </div>
      </FormField>

      {['POST', 'PUT', 'PATCH'].includes(config.method) && (
        <FormField label={acf.requestBody}>
          <VariableInput
            value={typeof config.body === 'object' ? JSON.stringify(config.body, null, 2) : config.body || ''}
            onChange={(v) => {
              try {
                onChange({ ...config, body: JSON.parse(v) });
              } catch {
                onChange({ ...config, body: v });
              }
            }}
            placeholder='{"key": "value"}'
            multiline
            rows={6}
            triggerType={triggerType}
            steps={steps}
            workflowVariables={workflowVariables}
          />
        </FormField>
      )}

      <FormField label={acf.contentType}>
        <Select
          value={config.contentType || 'application/json'}
          onValueChange={(value) => onChange({ ...config, contentType: value })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="application/json">application/json</SelectItem>
            <SelectItem value="application/x-www-form-urlencoded">application/x-www-form-urlencoded</SelectItem>
            <SelectItem value="multipart/form-data">multipart/form-data</SelectItem>
            <SelectItem value="text/plain">text/plain</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
    </div>
  );
}

// ============================================================================
// Condition Form - With step dropdowns
// ============================================================================
function ConditionForm({
  config,
  onChange,
  workflowSteps = [],
  currentStepIndex = 0,
  triggerType,
  workflowVariables = [],
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  workflowSteps?: WorkflowStep[];
  currentStepIndex?: number;
  triggerType?: string;
  workflowVariables?: WorkflowVariable[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  // Get steps that come after the current one
  const availableSteps = workflowSteps.slice(currentStepIndex + 1);
  const previousSteps = workflowSteps.slice(0, currentStepIndex);

  return (
    <div className="space-y-4">
      <FormField label={acf.fieldToCheck} required description={acf.fieldToCheckDesc}>
        <VariableInput
          value={config.field || ''}
          onChange={(v) => onChange({ ...config, field: v })}
          placeholder="{{trigger.data.status}}"
          triggerType={triggerType}
          steps={previousSteps}
          workflowVariables={workflowVariables}
        />
      </FormField>

      <FormField label={acf.operator} required>
        <Select
          value={config.operator || 'eq'}
          onValueChange={(value) => onChange({ ...config, operator: value })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="eq">{acf.operators.eq}</SelectItem>
            <SelectItem value="ne">{acf.operators.ne}</SelectItem>
            <SelectItem value="gt">{acf.operators.gt}</SelectItem>
            <SelectItem value="gte">{acf.operators.gte}</SelectItem>
            <SelectItem value="lt">{acf.operators.lt}</SelectItem>
            <SelectItem value="lte">{acf.operators.lte}</SelectItem>
            <SelectItem value="contains">{acf.operators.contains}</SelectItem>
            <SelectItem value="startswith">{acf.operators.startswith}</SelectItem>
            <SelectItem value="endswith">{acf.operators.endswith}</SelectItem>
            <SelectItem value="isEmpty">{acf.operators.isEmpty}</SelectItem>
            <SelectItem value="isNotEmpty">{acf.operators.isNotEmpty}</SelectItem>
            <SelectItem value="in">{acf.operators.in}</SelectItem>
            <SelectItem value="regex">{acf.operators.regex}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      {!['isEmpty', 'isNotEmpty'].includes(config.operator) && (
        <FormField label={acf.value} required description={acf.valueDesc}>
          <VariableInput
            value={config.value || ''}
            onChange={(v) => onChange({ ...config, value: v })}
            placeholder={st('sweep.weldflow.actionConfig.expectedValuePlaceholder')}
            triggerType={triggerType}
            steps={previousSteps}
            workflowVariables={workflowVariables}
          />
        </FormField>
      )}

      <div className="bg-muted/50 rounded-lg p-4 space-y-3">
        <p className="text-sm font-medium">{acf.branchActions}</p>

        <FormField label={acf.thenIfTrue} description={acf.thenIfTrueDesc}>
          <Select
            value={config.thenActionId || '__continue__'}
            onValueChange={(v) => onChange({ ...config, thenActionId: v === '__continue__' ? '' : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder={acf.continueToNextStep} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__continue__">{acf.continueToNextStep}</SelectItem>
              <SelectItem value="__stop__">{acf.stopWorkflow}</SelectItem>
              {availableSteps.map((step, idx) => (
                <SelectItem key={step.id} value={step.id}>
                  {acf.stepNumber.replace('{number}', String(currentStepIndex + idx + 2))}: {step.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <FormField label={acf.elseIfFalse} description={acf.elseIfFalseDesc}>
          <Select
            value={config.elseActionId || '__continue__'}
            onValueChange={(v) => onChange({ ...config, elseActionId: v === '__continue__' ? '' : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder={acf.continueToNextStep} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__continue__">{acf.continueToNextStep}</SelectItem>
              <SelectItem value="__stop__">{acf.stopWorkflow}</SelectItem>
              {availableSteps.map((step, idx) => (
                <SelectItem key={step.id} value={step.id}>
                  {acf.stepNumber.replace('{number}', String(currentStepIndex + idx + 2))}: {step.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>
    </div>
  );
}

// ============================================================================
// Delay Form
// ============================================================================
function DelayForm({ config, onChange }: { config: Record<string, any>; onChange: (c: Record<string, any>) => void }) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const [unit, setUnit] = useState<'seconds' | 'minutes' | 'hours' | 'days'>(
    config.days ? 'days' : config.hours ? 'hours' : config.minutes ? 'minutes' : 'seconds'
  );
  const currentValue = config[unit] || config.seconds || 0;

  const handleChange = (value: number, newUnit: 'seconds' | 'minutes' | 'hours' | 'days') => {
    const newConfig = { ...config };
    delete newConfig.seconds;
    delete newConfig.minutes;
    delete newConfig.hours;
    delete newConfig.days;
    newConfig[newUnit] = value;
    onChange(newConfig);
    setUnit(newUnit);
  };

  return (
    <div className="space-y-4">
      <FormField label={acf.waitDuration} required description={acf.waitDurationDesc}>
        <div className="flex gap-2">
          <Input
            type="number"
            min={0}
            value={currentValue}
            onChange={(e) => handleChange(parseInt(e.target.value) || 0, unit)}
            className="flex-1"
          />
          <Select value={unit} onValueChange={(v) => handleChange(currentValue, v as any)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="seconds">{acf.durationUnits.seconds}</SelectItem>
              <SelectItem value="minutes">{acf.durationUnits.minutes}</SelectItem>
              <SelectItem value="hours">{acf.durationUnits.hours}</SelectItem>
              <SelectItem value="days">{acf.durationUnits.days}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </FormField>
    </div>
  );
}

// ============================================================================
// Log Message Form
// ============================================================================
function LogMessageForm({
  config,
  onChange,
  triggerType,
  steps = [],
  workflowVariables = [],
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  triggerType?: string;
  steps?: WorkflowStep[];
  workflowVariables?: WorkflowVariable[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  return (
    <div className="space-y-4">
      <FormField label={acf.message} required>
        <VariableInput
          value={config.message || ''}
          onChange={(v) => onChange({ ...config, message: v })}
          placeholder={st('sweep.weldflow.actionConfig.logMessagePlaceholder')}
          multiline
          rows={3}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
        />
      </FormField>

      <FormField label={acf.logLevel}>
        <Select
          value={config.level || 'info'}
          onValueChange={(value) => onChange({ ...config, level: value })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="debug">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-gray-400" />
                {acf.logLevels.debug}
              </span>
            </SelectItem>
            <SelectItem value="info">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500" />
                {acf.logLevels.info}
              </span>
            </SelectItem>
            <SelectItem value="warning">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-yellow-500" />
                {acf.logLevels.warning}
              </span>
            </SelectItem>
            <SelectItem value="error">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-500" />
                {acf.logLevels.error}
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </FormField>
    </div>
  );
}

// ============================================================================
// Transform Data Form
// ============================================================================
function TransformDataForm({
  config,
  onChange,
  triggerType,
  steps = [],
  workflowVariables = [],
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  triggerType?: string;
  steps?: WorkflowStep[];
  workflowVariables?: WorkflowVariable[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  return (
    <div className="space-y-4">
      <FormField label={acf.inputData} required description={acf.inputDataDesc}>
        <VariableInput
          value={typeof config.input === 'object' ? JSON.stringify(config.input, null, 2) : config.input || ''}
          onChange={(v) => {
            try {
              onChange({ ...config, input: JSON.parse(v) });
            } catch {
              onChange({ ...config, input: v });
            }
          }}
          placeholder='{{trigger.data}} or {"key": "value"}'
          multiline
          rows={4}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
        />
      </FormField>

      <FormField label={acf.transformation} required description={acf.transformationDesc}>
        <Textarea
          value={config.transformation || ''}
          onChange={(e) => onChange({ ...config, transformation: e.target.value })}
          placeholder="input.items.map(i => ({ id: i.id, total: i.price * i.quantity }))"
          rows={6}
          className="font-mono text-sm"
        />
      </FormField>

      <div className="bg-muted/50 rounded-lg p-3">
        <p className="text-xs text-muted-foreground">
          <strong>Tip:</strong> {acf.transformTip} <code className="bg-background px-1 rounded">input</code> variable.
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Create/Update Record Form - With FieldBuilder
// ============================================================================
function RecordForm({
  config,
  onChange,
  isUpdate,
  triggerType,
  steps = [],
  workflowVariables = [],
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  isUpdate?: boolean;
  triggerType?: string;
  steps?: WorkflowStep[];
  workflowVariables?: WorkflowVariable[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  return (
    <div className="space-y-4">
      <FormField label={acf.entityType} required>
        <EntityTypeSelect
          value={config.entityType || config.entity || ''}
          onChange={(value) => onChange({ ...config, entityType: value, entity: value })}
        />
      </FormField>

      {isUpdate && (
        <FormField label={acf.recordId} required>
          <VariableInput
            value={config.id || ''}
            onChange={(v) => onChange({ ...config, id: v })}
            placeholder="{{trigger.data.id}}"
            triggerType={triggerType}
            steps={steps}
            workflowVariables={workflowVariables}
          />
        </FormField>
      )}

      <FormField label={acf.fields} required description={acf.fieldsDesc}>
        <FieldBuilder
          fields={config.data || {}}
          onChange={(data) => onChange({ ...config, data })}
          entityType={config.entityType || config.entity}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
        />
      </FormField>

      {isUpdate && (
        <FormField label={acf.upsert} description={acf.upsertDesc}>
          <div className="flex items-center gap-2">
            <Switch
              checked={config.upsert || false}
              onCheckedChange={(checked) => onChange({ ...config, upsert: checked })}
            />
            <span className="text-sm text-muted-foreground">
              {config.upsert ? acf.upsertYes : acf.upsertNo}
            </span>
          </div>
        </FormField>
      )}
    </div>
  );
}

// ============================================================================
// Delete Record Form
// ============================================================================
function DeleteRecordForm({
  config,
  onChange,
  triggerType,
  steps = [],
  workflowVariables = [],
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  triggerType?: string;
  steps?: WorkflowStep[];
  workflowVariables?: WorkflowVariable[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  return (
    <div className="space-y-4">
      <FormField label={acf.entityType} required>
        <EntityTypeSelect
          value={config.entityType || config.entity || ''}
          onChange={(value) => onChange({ ...config, entityType: value, entity: value })}
        />
      </FormField>

      <FormField label={acf.recordId} required>
        <VariableInput
          value={config.id || ''}
          onChange={(v) => onChange({ ...config, id: v })}
          placeholder="{{trigger.data.id}}"
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
        />
      </FormField>

      <FormField label={acf.softDelete} description={acf.softDeleteDesc}>
        <div className="flex items-center gap-2">
          <Switch
            checked={config.softDelete !== false}
            onCheckedChange={(checked) => onChange({ ...config, softDelete: checked })}
          />
          <span className="text-sm text-muted-foreground">
            {config.softDelete !== false ? acf.softDeleteYes : acf.softDeleteNo}
          </span>
        </div>
      </FormField>

      {config.softDelete === false && (
        <div className="bg-red-50 dark:bg-red-950/30 rounded-lg p-3 flex items-start gap-2">
          <Info className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
          <p className="text-xs text-red-700 dark:text-red-300">
            <strong>Warning:</strong> {acf.permanentDeleteWarning}
          </p>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Query Data Form - With FilterBuilder
// ============================================================================
function QueryDataForm({
  config,
  onChange,
  triggerType,
  steps = [],
  workflowVariables = [],
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  triggerType?: string;
  steps?: WorkflowStep[];
  workflowVariables?: WorkflowVariable[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  return (
    <div className="space-y-4">
      <FormField label={acf.entityType} required>
        <EntityTypeSelect
          value={config.entityType || config.entity || ''}
          onChange={(value) => onChange({ ...config, entityType: value, entity: value })}
        />
      </FormField>

      <FormField label={acf.filters} description={acf.filtersDesc}>
        <FilterBuilder
          filters={config.filters || []}
          onChange={(filters) => onChange({ ...config, filters })}
          entityType={config.entityType || config.entity}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
        />
      </FormField>

      <FormField label={acf.sortBy}>
        <div className="flex gap-2">
          <Input
            value={config.sortBy || ''}
            onChange={(e) => onChange({ ...config, sortBy: e.target.value })}
            placeholder={acf.sortByPlaceholder}
            className="flex-1"
          />
          <Select
            value={config.sortOrder || 'desc'}
            onValueChange={(v) => onChange({ ...config, sortOrder: v })}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="asc">{acf.sortOrder.asc}</SelectItem>
              <SelectItem value="desc">{acf.sortOrder.desc}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </FormField>

      <FormField label={acf.limit} description={acf.limitDesc}>
        <Input
          type="number"
          min={1}
          max={1000}
          value={config.limit || 100}
          onChange={(e) => onChange({ ...config, limit: parseInt(e.target.value) || 100 })}
        />
      </FormField>
    </div>
  );
}

// ============================================================================
// Loop Form - With step dropdown
// ============================================================================
function LoopForm({
  config,
  onChange,
  workflowSteps = [],
  currentStepIndex = 0,
  triggerType,
  workflowVariables = [],
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  workflowSteps?: WorkflowStep[];
  currentStepIndex?: number;
  triggerType?: string;
  workflowVariables?: WorkflowVariable[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const previousSteps = workflowSteps.slice(0, currentStepIndex);
  const availableSteps = workflowSteps.slice(currentStepIndex + 1);

  return (
    <div className="space-y-4">
      <FormField label={acf.itemsToIterate} required description={acf.itemsToIterateDesc}>
        <VariableInput
          value={config.items || ''}
          onChange={(v) => onChange({ ...config, items: v })}
          placeholder="{{trigger.data.items}}"
          triggerType={triggerType}
          steps={previousSteps}
          workflowVariables={workflowVariables}
        />
      </FormField>

      <FormField label={acf.actionToExecute} description={acf.actionToExecuteDesc}>
        <Select
          value={config.action || ''}
          onValueChange={(v) => onChange({ ...config, action: v })}
        >
          <SelectTrigger>
            <SelectValue placeholder={acf.selectStep} />
          </SelectTrigger>
          <SelectContent>
            {availableSteps.map((step, idx) => (
              <SelectItem key={step.id} value={step.id}>
                {acf.stepNumber.replace('{number}', String(currentStepIndex + idx + 2))}: {step.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-3 flex items-start gap-2">
        <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
        <p className="text-xs text-blue-700 dark:text-blue-300">
          {acf.loopTip} <code className="bg-white/50 dark:bg-black/20 px-1 rounded">{acf.loopItemVar}</code> {acf.loopItemDesc}{' '}
          {acf.loopTip} <code className="bg-white/50 dark:bg-black/20 px-1 rounded">{acf.loopIndexVar}</code> {acf.loopIndexDesc}
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Set Variable Form
// ============================================================================
function SetVariableForm({
  config,
  onChange,
  triggerType,
  steps = [],
  workflowVariables = [],
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  triggerType?: string;
  steps?: WorkflowStep[];
  workflowVariables?: WorkflowVariable[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  return (
    <div className="space-y-4">
      <FormField label={acf.variableName} required description={acf.variableNameDesc}>
        <Input
          value={config.name || ''}
          onChange={(e) => onChange({ ...config, name: e.target.value })}
          placeholder="myVariable"
        />
      </FormField>

      <FormField label={acf.value} required>
        <VariableInput
          value={typeof config.value === 'object' ? JSON.stringify(config.value, null, 2) : String(config.value ?? '')}
          onChange={(v) => {
            try {
              onChange({ ...config, value: JSON.parse(v) });
            } catch {
              onChange({ ...config, value: v });
            }
          }}
          placeholder="{{trigger.data.total * 1.1}}"
          multiline
          rows={3}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
        />
      </FormField>

      <FormField label={acf.scope}>
        <Select
          value={config.scope || 'execution'}
          onValueChange={(value) => onChange({ ...config, scope: value })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="execution">{acf.variableScopes.execution}</SelectItem>
            <SelectItem value="workflow">{acf.variableScopes.workflow}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
    </div>
  );
}

// ============================================================================
// Send Notification Form
// ============================================================================
function SendNotificationForm({
  config,
  onChange,
  triggerType,
  steps = [],
  workflowVariables = [],
  workspaceMembers = [],
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  triggerType?: string;
  steps?: WorkflowStep[];
  workflowVariables?: WorkflowVariable[];
  workspaceMembers?: WorkspaceMember[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  const [open, setOpen] = useState(false);
  const selectedUserIds: string[] = config.userIds || [];

  // Find preceding assign_conversation steps
  const assignSteps = steps.filter((s) => s.type === 'assign_conversation');

  // Current recipient mode: 'assigned_agent' references a preceding assign step, 'manual' uses the member picker
  const recipientMode: string = config.recipientMode || (assignSteps.length > 0 ? 'assigned_agent' : 'manual');

  const handleToggleUser = (userId: string) => {
    const newUserIds = selectedUserIds.includes(userId)
      ? selectedUserIds.filter((id) => id !== userId)
      : [...selectedUserIds, userId];
    onChange({ ...config, userIds: newUserIds });
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div className="space-y-4">
      <FormField label={acf.title} required>
        <VariableInput
          value={config.title || ''}
          onChange={(v) => onChange({ ...config, title: v })}
          placeholder={st('sweep.weldflow.actionConfig.notificationTitlePlaceholder')}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
        />
      </FormField>

      <FormField label={acf.notificationBody}>
        <VariableInput
          value={config.body || ''}
          onChange={(v) => onChange({ ...config, body: v })}
          placeholder={st('sweep.weldflow.actionConfig.notificationBodyPlaceholder')}
          multiline
          rows={3}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
        />
      </FormField>

      <FormField label={acf.recipient} required description={acf.recipientDesc}>
        {assignSteps.length > 0 ? (
          <div className="space-y-3">
            <Select
              value={recipientMode}
              onValueChange={(v) => {
                if (v === 'assigned_agent') {
                  // Auto-select the first assign step reference
                  const step = assignSteps[0];
                  onChange({
                    ...config,
                    recipientMode: 'assigned_agent',
                    assignStepRef: step.id,
                    userIds: [`{{steps.${step.id}.assignedUserId}}`],
                  });
                } else {
                  onChange({ ...config, recipientMode: 'manual', assignStepRef: undefined, userIds: [] });
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="assigned_agent">{acf.assignedAgent}</SelectItem>
                <SelectItem value="manual">{acf.specificUsers}</SelectItem>
              </SelectContent>
            </Select>

            {recipientMode === 'assigned_agent' && (
              <div className="space-y-2">
                {assignSteps.length === 1 ? (
                  <p className="text-xs text-muted-foreground">
                    {acf.notifiesAgentIn} <span className="font-medium text-foreground">{assignSteps[0].name || 'Assign Conversation'}</span>
                  </p>
                ) : (
                  <Select
                    value={config.assignStepRef || assignSteps[0].id}
                    onValueChange={(stepId) => {
                      onChange({
                        ...config,
                        assignStepRef: stepId,
                        userIds: [`{{steps.${stepId}.assignedUserId}}`],
                      });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={acf.selectAssignStep} />
                    </SelectTrigger>
                    <SelectContent>
                      {assignSteps.map((s, i) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name || acf.assignConversationStep.replace('{number}', String(i + 1))}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {recipientMode === 'manual' && (
              <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    className="w-full justify-between h-auto min-h-10"
                  >
                    {selectedUserIds.length === 0 ? (
                      <span className="text-muted-foreground">{acf.selectUsers}</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {selectedUserIds.slice(0, 3).map((userId) => {
                          const member = workspaceMembers.find((m) => m.id === userId);
                          return (
                            <Badge key={userId} variant="secondary" className="text-xs">
                              {member?.name || userId}
                            </Badge>
                          );
                        })}
                        {selectedUserIds.length > 3 && (
                          <Badge variant="secondary" className="text-xs">
                            {acf.moreBadge.replace('{count}', String(selectedUserIds.length - 3))}
                          </Badge>
                        )}
                      </div>
                    )}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[350px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder={acf.searchUsers} />
                    <CommandList>
                      <CommandEmpty>{acf.noUsersFound}</CommandEmpty>
                      <CommandGroup>
                        {workspaceMembers.map((member) => {
                          const isSelected = selectedUserIds.includes(member.id);
                          return (
                            <CommandItem
                              key={member.id}
                              value={`${member.name} ${member.email}`}
                              onSelect={() => handleToggleUser(member.id)}
                            >
                              <div className="flex items-center gap-3 w-full">
                                <Checkbox checked={isSelected} />
                                <Avatar className="h-6 w-6">
                                  <AvatarImage src={member.avatar} alt={member.name} />
                                  <AvatarFallback className="text-xs">
                                    {getInitials(member.name)}
                                  </AvatarFallback>
                                </Avatar>
                                <div className="flex flex-col flex-1 min-w-0">
                                  <span className="text-sm font-medium truncate">{member.name}</span>
                                  <span className="text-xs text-muted-foreground truncate">{member.email}</span>
                                </div>
                                {isSelected && <Check className="h-4 w-4 text-primary" />}
                              </div>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            )}
          </div>
        ) : (
          /* No assign step in workflow — show regular member picker */
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={open}
                className="w-full justify-between h-auto min-h-10"
              >
                {selectedUserIds.length === 0 ? (
                  <span className="text-muted-foreground">{acf.selectUsers}</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {selectedUserIds.slice(0, 3).map((userId) => {
                      const member = workspaceMembers.find((m) => m.id === userId);
                      return (
                        <Badge key={userId} variant="secondary" className="text-xs">
                          {member?.name || userId}
                        </Badge>
                      );
                    })}
                    {selectedUserIds.length > 3 && (
                      <Badge variant="secondary" className="text-xs">
                        {acf.moreBadge.replace('{count}', String(selectedUserIds.length - 3))}
                      </Badge>
                    )}
                  </div>
                )}
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[350px] p-0" align="start">
              <Command>
                <CommandInput placeholder={acf.searchUsers} />
                <CommandList>
                  <CommandEmpty>{acf.noUsersFound}</CommandEmpty>
                  <CommandGroup>
                    {workspaceMembers.map((member) => {
                      const isSelected = selectedUserIds.includes(member.id);
                      return (
                        <CommandItem
                          key={member.id}
                          value={`${member.name} ${member.email}`}
                          onSelect={() => handleToggleUser(member.id)}
                        >
                          <div className="flex items-center gap-3 w-full">
                            <Checkbox checked={isSelected} />
                            <Avatar className="h-6 w-6">
                              <AvatarImage src={member.avatar} alt={member.name} />
                              <AvatarFallback className="text-xs">
                                {getInitials(member.name)}
                              </AvatarFallback>
                            </Avatar>
                            <div className="flex flex-col flex-1 min-w-0">
                              <span className="text-sm font-medium truncate">{member.name}</span>
                              <span className="text-xs text-muted-foreground truncate">{member.email}</span>
                            </div>
                            {isSelected && <Check className="h-4 w-4 text-primary" />}
                          </div>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}
        {workspaceMembers.length === 0 && assignSteps.length === 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            {acf.noWorkspaceMembers}
          </p>
        )}
      </FormField>

      <div className="grid grid-cols-2 gap-4">
        <FormField label={acf.category}>
          <Select
            value={config.category || 'task'}
            onValueChange={(v) => onChange({ ...config, category: v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="task">{acf.notificationCategories.task}</SelectItem>
              <SelectItem value="helpdesk">{acf.notificationCategories.helpdesk}</SelectItem>
              <SelectItem value="crm">{acf.notificationCategories.crm}</SelectItem>
              <SelectItem value="commerce">{acf.notificationCategories.commerce}</SelectItem>
              <SelectItem value="projects">{acf.notificationCategories.projects}</SelectItem>
              <SelectItem value="mail">{acf.notificationCategories.mail}</SelectItem>
              <SelectItem value="parcel">{acf.notificationCategories.parcel}</SelectItem>
              <SelectItem value="system">{acf.notificationCategories.system}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>

        <FormField label={acf.severity}>
          <Select
            value={config.severity || 'info'}
            onValueChange={(v) => onChange({ ...config, severity: v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="info">{acf.severities.info}</SelectItem>
              <SelectItem value="success">{acf.severities.success}</SelectItem>
              <SelectItem value="warning">{acf.severities.warning}</SelectItem>
              <SelectItem value="error">{acf.severities.error}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </div>

      <FormField label={acf.actionUrl} description={acf.actionUrlDesc}>
        <VariableInput
          value={config.actionUrl || ''}
          onChange={(v) => onChange({ ...config, actionUrl: v })}
          placeholder="/weldflow/projects/{{trigger.data.projectId}}"
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
        />
      </FormField>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================
// ============================================================================
// Helpdesk Action Forms
// ============================================================================

function AssignConversationForm({ config, onChange, workspaceMembers = [] }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
  workspaceMembers?: WorkspaceMember[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  return (
    <div className="space-y-4">
      <FormField label={acf.assignmentStrategy} required>
        <Select
          value={config.strategy || ''}
          onValueChange={(v) => onChange({ ...config, strategy: v })}
        >
          <SelectTrigger><SelectValue placeholder={acf.selectStrategy} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="specific_agent">{acf.strategies.specific_agent}</SelectItem>
            <SelectItem value="department">{acf.strategies.department}</SelectItem>
            <SelectItem value="round_robin">{acf.strategies.round_robin}</SelectItem>
            <SelectItem value="least_busy">{acf.strategies.least_busy}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      {config.strategy === 'specific_agent' && (
        <FormField label={acf.agent} required>
          <Select
            value={config.agentId || ''}
            onValueChange={(v) => {
              const member = workspaceMembers.find(m => m.id === v);
              onChange({ ...config, agentId: v, agentName: member?.name });
            }}
          >
            <SelectTrigger><SelectValue placeholder={acf.selectAgent} /></SelectTrigger>
            <SelectContent>
              {workspaceMembers.map(m => (
                <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}

      {config.strategy === 'department' && (
        <FormField label={acf.departmentId} required description={acf.departmentIdDesc}>
          <Input
            value={config.departmentId || ''}
            onChange={(e) => onChange({ ...config, departmentId: e.target.value })}
            placeholder="dept_..."
          />
        </FormField>
      )}
    </div>
  );
}

function TagConversationForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const [tagInput, setTagInput] = useState('');
  const tags: string[] = config.tags || [];

  const addTag = () => {
    const tag = tagInput.trim();
    if (tag && !tags.includes(tag)) {
      onChange({ ...config, tags: [...tags, tag] });
      setTagInput('');
    }
  };

  return (
    <div className="space-y-4">
      <FormField label={acf.mode}>
        <Select
          value={config.mode || 'add'}
          onValueChange={(v) => onChange({ ...config, mode: v })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="add">{acf.tagModes.add}</SelectItem>
            <SelectItem value="remove">{acf.tagModes.remove}</SelectItem>
            <SelectItem value="replace">{acf.tagModes.replace}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      <FormField label={acf.tags} required>
        <div className="flex gap-2">
          <Input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
            placeholder={acf.typeTagAndEnter}
            className="flex-1"
          />
          <Button type="button" variant="outline" size="sm" onClick={addTag}>
            <Plus className="h-3 w-3" />
          </Button>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {tags.map(tag => (
              <Badge key={tag} variant="secondary" className="gap-1">
                {tag}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onChange({ ...config, tags: tags.filter(t => t !== tag) })}
                  className="ml-0.5 hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </Button>
              </Badge>
            ))}
          </div>
        )}
      </FormField>
    </div>
  );
}

function ChangeConversationStatusForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  return (
    <div className="space-y-4">
      <FormField label={acf.status} required>
        <Select
          value={config.status || ''}
          onValueChange={(v) => onChange({ ...config, status: v })}
        >
          <SelectTrigger><SelectValue placeholder={acf.selectStatus} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="active">{acf.conversationStatuses.active}</SelectItem>
            <SelectItem value="pending">{acf.conversationStatuses.pending}</SelectItem>
            <SelectItem value="resolved">{acf.conversationStatuses.resolved}</SelectItem>
            <SelectItem value="closed">{acf.conversationStatuses.closed}</SelectItem>
            <SelectItem value="snoozed">{acf.conversationStatuses.snoozed}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      {config.status === 'snoozed' && (
        <FormField label={acf.snoozeDuration} description={acf.snoozeDurationDesc}>
          <Input
            type="number"
            value={config.snoozeDurationMinutes || ''}
            onChange={(e) => onChange({ ...config, snoozeDurationMinutes: parseInt(e.target.value) || undefined })}
            placeholder="60"
            min={1}
          />
        </FormField>
      )}
    </div>
  );
}

function ChangePriorityForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  return (
    <FormField label={acf.priority} required>
      <Select
        value={config.priority || ''}
        onValueChange={(v) => onChange({ ...config, priority: v })}
      >
        <SelectTrigger><SelectValue placeholder={acf.selectPriority} /></SelectTrigger>
        <SelectContent>
          <SelectItem value="low">{acf.priorities.low}</SelectItem>
          <SelectItem value="medium">{acf.priorities.medium}</SelectItem>
          <SelectItem value="high">{acf.priorities.high}</SelectItem>
          <SelectItem value="urgent">{acf.priorities.urgent}</SelectItem>
          <SelectItem value="critical">{acf.priorities.critical}</SelectItem>
        </SelectContent>
      </Select>
    </FormField>
  );
}

function SendReplyForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  return (
    <div className="space-y-4">
      <FormField label={acf.message} required description={acf.messageDesc}>
        <Textarea
          value={config.message || ''}
          onChange={(e) => onChange({ ...config, message: e.target.value })}
          placeholder={st('sweep.weldflow.actionConfig.replyMessagePlaceholder')}
          rows={5}
        />
      </FormField>
      <FormField label={acf.authorType} description={acf.authorTypeDesc}>
        <Select
          value={config.authorType || 'system'}
          onValueChange={(v) => onChange({ ...config, authorType: v })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{acf.authorTypes.system}</SelectItem>
            <SelectItem value="agent">{acf.authorTypes.agent}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
    </div>
  );
}

function AddInternalNoteForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  return (
    <div className="space-y-4">
      <FormField label={acf.noteContent} required description={acf.noteContentDesc}>
        <Textarea
          value={config.content || ''}
          onChange={(e) => onChange({ ...config, content: e.target.value })}
          placeholder={st('sweep.weldflow.actionConfig.internalNotePlaceholder')}
          rows={4}
        />
      </FormField>
    </div>
  );
}

function CreateTicketFromConversationForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  return (
    <div className="space-y-4">
      <FormField label={acf.category}>
        <Select
          value={config.category || 'general_inquiry'}
          onValueChange={(v) => onChange({ ...config, category: v })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="technical_support">{acf.ticketCategories.technical_support}</SelectItem>
            <SelectItem value="billing">{acf.ticketCategories.billing}</SelectItem>
            <SelectItem value="sales">{acf.ticketCategories.sales}</SelectItem>
            <SelectItem value="general_inquiry">{acf.ticketCategories.general_inquiry}</SelectItem>
            <SelectItem value="feature_request">{acf.ticketCategories.feature_request}</SelectItem>
            <SelectItem value="bug_report">{acf.ticketCategories.bug_report}</SelectItem>
            <SelectItem value="complaint">{acf.ticketCategories.complaint}</SelectItem>
            <SelectItem value="other">{acf.ticketCategories.other}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      <FormField label={acf.priority}>
        <Select
          value={config.priority || 'medium'}
          onValueChange={(v) => onChange({ ...config, priority: v })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="low">{acf.priorities.low}</SelectItem>
            <SelectItem value="medium">{acf.priorities.medium}</SelectItem>
            <SelectItem value="high">{acf.priorities.high}</SelectItem>
            <SelectItem value="urgent">{acf.priorities.urgent}</SelectItem>
            <SelectItem value="critical">{acf.priorities.critical}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
    </div>
  );
}

function ApplySlaForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  return (
    <div className="space-y-4">
      <FormField label={acf.slaPolicyId} required description={acf.slaPolicyIdDesc}>
        <Input
          value={config.slaId || ''}
          onChange={(e) => onChange({ ...config, slaId: e.target.value })}
          placeholder="sla_..."
        />
      </FormField>
    </div>
  );
}

function TriggerCsatForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  return (
    <div className="space-y-4">
      <FormField label={acf.delayMinutes} description={acf.delayMinutesDesc}>
        <Input
          type="number"
          value={config.delayMinutes || ''}
          onChange={(e) => onChange({ ...config, delayMinutes: parseInt(e.target.value) || undefined })}
          placeholder="0"
          min={0}
        />
      </FormField>
    </div>
  );
}

function SendBotMessageForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  return (
    <FormField label={acf.message} required description={acf.messageDesc}>
      <Textarea
        value={config.message || ''}
        onChange={(e) => onChange({ ...config, message: e.target.value })}
        placeholder={st('sweep.weldflow.actionConfig.botMessagePlaceholder')}
        rows={4}
      />
    </FormField>
  );
}

function SendChoicesForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  const options: Array<{ id: string; label: string; value: string }> = config.options || [];

  const addOption = () => {
    const newOption = { id: `opt_${Date.now()}`, label: '', value: '' };
    onChange({ ...config, options: [...options, newOption] });
  };

  const updateOption = (index: number, field: 'label' | 'value', val: string) => {
    const updated = options.map((opt, i) => i === index ? { ...opt, [field]: val } : opt);
    onChange({ ...config, options: updated });
  };

  const removeOption = (index: number) => {
    onChange({ ...config, options: options.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-4">
      <FormField label={acf.promptMessage} required description={acf.promptMessageAboveButtons}>
        <Textarea
          value={config.message || ''}
          onChange={(e) => onChange({ ...config, message: e.target.value })}
          placeholder={st('sweep.weldflow.actionConfig.promptMessagePlaceholder')}
          rows={3}
        />
      </FormField>

      <FormField label={acf.options} required description={acf.optionsAtLeastTwo}>
        <div className="space-y-2">
          {options.map((opt, index) => (
            <div key={opt.id} className="flex items-center gap-2">
              <Input
                value={opt.label}
                onChange={(e) => updateOption(index, 'label', e.target.value)}
                placeholder={acf.buttonLabel}
                className="flex-1"
              />
              <Input
                value={opt.value}
                onChange={(e) => updateOption(index, 'value', e.target.value)}
                placeholder={st('sweep.weldflow.actionConfig.optionValuePlaceholder')}
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeOption(index)}
                disabled={options.length <= 2}
                className="shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addOption} className="gap-1">
            <Plus className="h-3 w-3" />
            {acf.addOption}
          </Button>
        </div>
      </FormField>
    </div>
  );
}

function CollectInputForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  const fields: Array<{ id: string; label: string; type: string; required: boolean; placeholder?: string }> = config.fields || [];

  const addField = (preset?: { label: string; type: string }) => {
    const newField = {
      id: `fld_${Date.now()}`,
      label: preset?.label || '',
      type: preset?.type || 'text',
      required: true,
      placeholder: '',
    };
    onChange({ ...config, fields: [...fields, newField] });
  };

  const updateField = (index: number, updates: Record<string, any>) => {
    const updated = fields.map((f, i) => i === index ? { ...f, ...updates } : f);
    onChange({ ...config, fields: updated });
  };

  const removeField = (index: number) => {
    onChange({ ...config, fields: fields.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-4">
      <FormField label={acf.promptMessage} required description={acf.promptMessageAboveFields}>
        <Textarea
          value={config.message || ''}
          onChange={(e) => onChange({ ...config, message: e.target.value })}
          placeholder={st('sweep.weldflow.actionConfig.collectInputPromptPlaceholder')}
          rows={3}
        />
      </FormField>

      <FormField label={acf.fields} required description={acf.fieldsAtLeastOne}>
        <div className="space-y-3">
          {fields.map((field, index) => (
            <div key={field.id} className="rounded-md border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  value={field.label}
                  onChange={(e) => updateField(index, { label: e.target.value })}
                  placeholder={acf.fieldLabel}
                  className="flex-1"
                />
                <Select
                  value={field.type}
                  onValueChange={(v) => updateField(index, { type: v })}
                >
                  <SelectTrigger className="w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="text">{acf.fieldTypes2.text}</SelectItem>
                    <SelectItem value="email">{acf.fieldTypes2.email}</SelectItem>
                    <SelectItem value="phone">{acf.fieldTypes2.phone}</SelectItem>
                    <SelectItem value="number">{acf.fieldTypes2.number}</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeField(index)}
                  className="shrink-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex items-center gap-4">
                <Input
                  value={field.placeholder || ''}
                  onChange={(e) => updateField(index, { placeholder: e.target.value })}
                  placeholder={acf.placeholderText}
                  className="flex-1 text-sm"
                />
                <div className="flex items-center gap-2">
                  <Switch
                    checked={field.required}
                    onCheckedChange={(v) => updateField(index, { required: v })}
                    id={`req-${field.id}`}
                  />
                  <Label htmlFor={`req-${field.id}`} className="text-xs whitespace-nowrap">{acf.required}</Label>
                </div>
              </div>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => addField()} className="gap-1">
              <Plus className="h-3 w-3" />
              {acf.addFieldButton}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => addField({ label: 'Email', type: 'email' })}>
              {acf.emailPreset}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => addField({ label: 'Name', type: 'text' })}>
              {acf.namePreset}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => addField({ label: 'Phone', type: 'phone' })}>
              {acf.phonePreset}
            </Button>
          </div>
        </div>
      </FormField>
    </div>
  );
}

const CUSTOMER_INFO_FIELDS = [
  { id: 'name', label: 'Name', type: 'text', placeholder: 'John Doe' },
  { id: 'email', label: 'Email', type: 'email', placeholder: 'your@email.com' },
  { id: 'phone', label: 'Phone', type: 'phone', placeholder: '+1 555 123 4567' },
  { id: 'company', label: 'Company', type: 'text', placeholder: 'Acme Inc.' },
] as const;

interface CustomerFieldConfig {
  id: string;
  required: boolean;
}

function parseFieldsConfig(raw: unknown): CustomerFieldConfig[] {
  if (!Array.isArray(raw) || raw.length === 0) return [{ id: 'email', required: true }];
  // New format: { id, required }[]
  if (typeof raw[0] === 'object' && 'required' in raw[0]) return raw as CustomerFieldConfig[];
  // Legacy string[]: treat all as optional except email
  if (typeof raw[0] === 'string') return (raw as string[]).map((id) => ({ id, required: id === 'email' }));
  // Legacy full objects from inputs
  return (raw as Array<{ id: string; required?: boolean }>).map((f) => ({ id: f.id, required: f.required ?? f.id === 'email' }));
}

function CollectCustomerInfoForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  const fieldConfigs = parseFieldsConfig(config.fields);
  const selectedIds = fieldConfigs.map((f) => f.id);

  const toggleField = (fieldId: string) => {
    const isSelected = selectedIds.includes(fieldId);
    const next = isSelected
      ? fieldConfigs.filter((f) => f.id !== fieldId)
      : [...fieldConfigs, { id: fieldId, required: false }];
    if (next.length === 0) return;
    onChange({ ...config, fields: next });
  };

  const toggleRequired = (fieldId: string) => {
    const next = fieldConfigs.map((f) =>
      f.id === fieldId ? { ...f, required: !f.required } : f,
    );
    onChange({ ...config, fields: next });
  };

  return (
    <div className="space-y-4">
      <FormField label={acf.promptMessage} description={acf.promptMessageAboveFields}>
        <Textarea
          value={config.message || ''}
          onChange={(e) => onChange({ ...config, message: e.target.value })}
          placeholder={st('sweep.weldflow.actionConfig.collectCustomerInfoPromptPlaceholder')}
          rows={3}
        />
      </FormField>

      <FormField label={acf.fieldsToCollect} required description={acf.fieldsToCollectDesc}>
        <div className="space-y-2">
          {CUSTOMER_INFO_FIELDS.map((field) => {
            const isSelected = selectedIds.includes(field.id);
            const fc = fieldConfigs.find((f) => f.id === field.id);
            return (
              <div
                key={field.id}
                className={cn(
                  'flex items-center gap-3 rounded-md border p-3 transition-colors',
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/30',
                )}
              >
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => toggleField(field.id)}
                />
                <div className="flex-1">
                  <span className="text-sm font-medium">{field.label}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{field.type}</span>
                </div>
                {isSelected && (
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={fc?.required ?? false}
                      onCheckedChange={() => toggleRequired(field.id)}
                      id={`req-${field.id}`}
                    />
                    <Label htmlFor={`req-${field.id}`} className="text-xs whitespace-nowrap">{acf.required}</Label>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </FormField>

      <FormField label={acf.skipIfKnown} description={acf.skipIfKnownDesc}>
        <div className="flex items-center gap-2">
          <Switch
            checked={config.skipIfKnown !== false}
            onCheckedChange={(v) => onChange({ ...config, skipIfKnown: v })}
            id="skip-if-known"
          />
          <Label htmlFor="skip-if-known" className="text-sm">{acf.enabled}</Label>
        </div>
      </FormField>
    </div>
  );
}

function AiAutoReplyForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  return (
    <div className="space-y-4">
      <FormField label={acf.agentName} description={acf.agentNameDesc}>
        <Input
          value={config.agentName || ''}
          onChange={(e) => onChange({ ...config, agentName: e.target.value })}
          placeholder={st('sweep.weldflow.actionConfig.aiAssistantNamePlaceholder')}
        />
      </FormField>
      <FormField label={acf.tone} description={acf.toneDesc}>
        <Select
          value={config.tone || 'professional and helpful'}
          onValueChange={(v) => onChange({ ...config, tone: v })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="professional and helpful">{acf.tones.professional}</SelectItem>
            <SelectItem value="friendly and casual">{acf.tones.friendly}</SelectItem>
            <SelectItem value="concise and direct">{acf.tones.concise}</SelectItem>
            <SelectItem value="empathetic and supportive">{acf.tones.empathetic}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
      <FormField label={acf.customInstructions} description={acf.customInstructionsDesc}>
        <Textarea
          value={config.instructions || ''}
          onChange={(e) => onChange({ ...config, instructions: e.target.value })}
          placeholder={st('sweep.weldflow.actionConfig.customInstructionsPlaceholder')}
          rows={3}
        />
      </FormField>
      <FormField label={acf.maxResponseLength} description={acf.maxResponseLengthDesc}>
        <Input
          type="number"
          value={config.maxTokens || 500}
          onChange={(e) => onChange({ ...config, maxTokens: parseInt(e.target.value) || 500 })}
          min={50}
          max={2000}
        />
      </FormField>
    </div>
  );
}

// ============================================================================
// AI Generate Form — `ai_generate` action (apps/workers/workflow-worker/src/engine/actions/ai.ts).
// Config field names (`prompt`, `systemPrompt`, `model`, `temperature`,
// `maxTokens`) match exactly what the engine reads first.
// ============================================================================
function AiGenerateForm({
  config,
  onChange,
  triggerType,
  steps = [],
  workflowVariables = [],
  extraVariableGroups,
  excludeGroups,
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  triggerType?: string;
  steps?: WorkflowStep[];
  workflowVariables?: WorkflowVariable[];
  extraVariableGroups?: VariableGroup[];
  excludeGroups?: string[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  const temperature = typeof config.temperature === 'number' ? config.temperature : 0.7;

  return (
    <div className="space-y-4">
      <FormField label={acf.prompt} description={acf.promptDesc} required>
        <VariableInput
          value={config.prompt || ''}
          onChange={(v) => onChange({ ...config, prompt: v })}
          placeholder={st('sweep.weldflow.actionConfig.aiPromptPlaceholder')}
          multiline
          rows={4}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
          extraVariableGroups={extraVariableGroups}
          excludeGroups={excludeGroups}
        />
      </FormField>

      <FormField label={acf.systemPrompt} description={acf.systemPromptDesc}>
        <Textarea
          value={config.systemPrompt || ''}
          onChange={(e) => onChange({ ...config, systemPrompt: e.target.value })}
          placeholder={st('sweep.weldflow.actionConfig.systemPromptPlaceholder')}
          rows={2}
        />
      </FormField>

      <FormField label={acf.model} description={acf.modelDesc}>
        <Input
          value={config.model || ''}
          onChange={(e) => onChange({ ...config, model: e.target.value || undefined })}
          placeholder={st('sweep.weldflow.actionConfig.recommendedDefaultPlaceholder')}
        />
      </FormField>

      <FormField label={acf.temperature} description={acf.temperatureDesc}>
        <div className="flex items-center gap-3">
          <Slider
            value={[temperature]}
            onValueChange={([v]) => onChange({ ...config, temperature: v })}
            min={0}
            max={1}
            step={0.1}
            className="flex-1"
          />
          <span className="w-10 text-right text-sm text-muted-foreground">{temperature.toFixed(1)}</span>
        </div>
      </FormField>

      <FormField label={acf.maxTokens} description={acf.maxTokensDesc}>
        <Input
          type="number"
          value={config.maxTokens ?? ''}
          onChange={(e) => onChange({ ...config, maxTokens: e.target.value ? parseInt(e.target.value, 10) : undefined })}
          min={1}
          placeholder="1024"
        />
      </FormField>
    </div>
  );
}

// ============================================================================
// AI Classify Form — `ai_classify` action (apps/workers/workflow-worker/src/engine/actions/ai.ts).
// Config field names (`text`, `categories`, `model`) match exactly what the
// engine reads first (`input`/`labels` are back-compat aliases only).
// ============================================================================
function AiClassifyForm({
  config,
  onChange,
  triggerType,
  steps = [],
  workflowVariables = [],
  extraVariableGroups,
  excludeGroups,
}: {
  config: Record<string, any>;
  onChange: (c: Record<string, any>) => void;
  triggerType?: string;
  steps?: WorkflowStep[];
  workflowVariables?: WorkflowVariable[];
  extraVariableGroups?: VariableGroup[];
  excludeGroups?: string[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  const [categoryInput, setCategoryInput] = useState('');
  const categories: string[] = config.categories || [];

  const addCategory = () => {
    const category = categoryInput.trim();
    if (category && !categories.includes(category)) {
      onChange({ ...config, categories: [...categories, category] });
      setCategoryInput('');
    }
  };

  return (
    <div className="space-y-4">
      <FormField label={acf.textToClassify} description={acf.textToClassifyDesc} required>
        <VariableInput
          value={config.text || ''}
          onChange={(v) => onChange({ ...config, text: v })}
          placeholder="{{trigger.data.message}}"
          multiline
          rows={4}
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
          extraVariableGroups={extraVariableGroups}
          excludeGroups={excludeGroups}
        />
      </FormField>

      <FormField label={acf.categories} description={acf.categoriesDesc} required>
        <div className="flex gap-2">
          <Input
            value={categoryInput}
            onChange={(e) => setCategoryInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCategory())}
            placeholder={acf.typeCategoryAndEnter}
            className="flex-1"
          />
          <Button type="button" variant="outline" size="sm" onClick={addCategory}>
            <Plus className="h-3 w-3" />
          </Button>
        </div>
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {categories.map((category) => (
              <Badge key={category} variant="secondary" className="gap-1">
                {category}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onChange({ ...config, categories: categories.filter((c) => c !== category) })}
                  className="ml-0.5 hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </Button>
              </Badge>
            ))}
          </div>
        )}
      </FormField>

      <FormField label={acf.model} description={acf.modelDesc}>
        <Input
          value={config.model || ''}
          onChange={(e) => onChange({ ...config, model: e.target.value || undefined })}
          placeholder={st('sweep.weldflow.actionConfig.recommendedDefaultPlaceholder')}
        />
      </FormField>
    </div>
  );
}

// ============================================================================
// AI Agent Form
// ============================================================================

const AVAILABLE_MODELS = [
  { value: 'openai/gpt-4o', label: 'GPT-4o' },
  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { value: 'anthropic/claude-3-5-haiku-latest', label: 'Claude Haiku' },
  { value: 'google/gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
];

const BUILTIN_TOOL_OPTIONS: Record<string, Array<{ name: string; label: string }>> = {
  general: [
    { name: 'search_knowledge_base', label: 'Search Knowledge Base' },
    { name: 'escalate_to_human', label: 'Escalate to Human' },
  ],
  helpdesk: [
    { name: 'get_conversation_history', label: 'Get Conversation History' },
    { name: 'get_customer_info', label: 'Get Customer Info' },
    { name: 'get_order_status', label: 'Get Order Status' },
    { name: 'search_tickets', label: 'Search Tickets' },
    { name: 'send_message_to_customer', label: 'Send Message to Customer' },
    { name: 'tag_conversation', label: 'Tag Conversation' },
    { name: 'update_conversation_status', label: 'Update Conversation Status' },
    { name: 'create_ticket', label: 'Create Ticket' },
    { name: 'assign_conversation', label: 'Assign Conversation' },
  ],
  crm: [
    { name: 'search_contacts', label: 'Search Contacts' },
    { name: 'get_contact_details', label: 'Get Contact Details' },
    { name: 'create_note', label: 'Create Note' },
  ],
  projects: [
    { name: 'search_tasks', label: 'Search Tasks' },
    { name: 'create_task', label: 'Create Task' },
  ],
};

function AiAgentForm({ config, onChange }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  const { getClient: getAppApiClient } = useAppApiClient();
  const [configMode, setConfigMode] = useState<'saved' | 'inline'>(
    config.agentDefinitionId ? 'saved' : 'inline'
  );

  // Saved agent definitions.
  //
  // AI (and ai_agent_definitions) was removed platform-wide (2026-07-08):
  // `/ai/agent-definitions` was deleted from api-worker in 453cd3204 and has no
  // app-api equivalent, so this 404'd and `savedAgents` was always undefined.
  // Stubbed to `[]` to match workflow-editor-client.tsx, which already stubs this
  // exact `['ai-agents-all']` key the same way — sharing a query key with two
  // different fetchers is precisely how you get cache that flip-flops.
  // The "saved" tab below renders its own empty state off this.
  const { data: savedAgents } = useQuery({
    queryKey: ['ai-agents-all'],
    queryFn: async (): Promise<Array<{ id: string; name: string; description?: string; moduleKey: string }>> => [],
    staleTime: Infinity,
  });

  // Fetch MCP integration connections
  const { data: mcpConnections } = useQuery({
    queryKey: ['integration-connections-mcp'],
    queryFn: async () => {
      const client = await getAppApiClient();
      const res = await client.get<{ data: Array<{
        id: string;
        name: string;
        provider: string;
        status: string;
        settings: {
          discoveredTools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
          [key: string]: unknown;
        };
      }> }>('/integrations/connections');
      return (res.data || []).filter((c: any) => c.provider === 'mcp_server' && c.status === 'active');
    },
  });

  const [expandedIntegrations, setExpandedIntegrations] = useState<Set<string>>(new Set());

  const moduleKey = config.moduleKey || 'general';
  const enabledTools: string[] = config.enabledBuiltinTools || [];

  const availableTools = [
    ...(BUILTIN_TOOL_OPTIONS.general || []),
    ...(BUILTIN_TOOL_OPTIONS[moduleKey] || []),
  ];

  const toggleTool = (toolName: string) => {
    const newTools = enabledTools.includes(toolName)
      ? enabledTools.filter((t: string) => t !== toolName)
      : [...enabledTools, toolName];
    onChange({ ...config, enabledBuiltinTools: newTools });
  };

  const handleSelectAgent = (agentId: string) => {
    if (agentId === '__inline__') {
      setConfigMode('inline');
      onChange({ ...config, agentDefinitionId: undefined });
    } else {
      setConfigMode('saved');
      onChange({ agentDefinitionId: agentId });
    }
  };

  return (
    <div className="space-y-4">
      <FormField label={acf.agentSelect} description={acf.agentSelectDesc}>
        <Select
          value={configMode === 'saved' && config.agentDefinitionId ? config.agentDefinitionId : '__inline__'}
          onValueChange={handleSelectAgent}
        >
          <SelectTrigger><SelectValue placeholder={acf.selectAnAgent} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__inline__">{acf.configureInline}</SelectItem>
            {(savedAgents || []).map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      {configMode === 'saved' && config.agentDefinitionId && (
        <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
          {acf.usingSavedAgent}{' '}
          <a href="/welddesk/weldagent" className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer">
            {acf.weldAgent}
          </a>.
        </div>
      )}

      {configMode === 'inline' && (
        <>
          <FormField label={acf.systemPrompt} description={acf.systemPromptDesc} required>
            <Textarea
              value={config.systemPrompt || ''}
              onChange={(e) => onChange({ ...config, systemPrompt: e.target.value })}
              placeholder={st('sweep.weldflow.actionConfig.aiAgentSystemPromptPlaceholder')}
              rows={5}
            />
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField label={acf.model}>
              <Select
                value={config.modelId || 'openai/gpt-4o'}
                onValueChange={(v) => onChange({ ...config, modelId: v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AVAILABLE_MODELS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label={acf.module}>
              <Select
                value={moduleKey}
                onValueChange={(v) => onChange({ ...config, moduleKey: v, enabledBuiltinTools: [] })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="general">{acf.modules.general}</SelectItem>
                  <SelectItem value="helpdesk">{acf.modules.helpdesk}</SelectItem>
                  <SelectItem value="crm">{acf.modules.crm}</SelectItem>
                  <SelectItem value="projects">{acf.modules.projects}</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField label={acf.builtinTools} description={acf.builtinToolsDesc}>
            <div className="space-y-2 rounded-lg border p-3 max-h-[200px] overflow-y-auto">
              {availableTools.map((tool) => (
                <label key={tool.name} className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={enabledTools.includes(tool.name)}
                    onCheckedChange={() => toggleTool(tool.name)}
                  />
                  <span className="text-sm">{tool.label}</span>
                </label>
              ))}
            </div>
          </FormField>

          {/* Integrations (MCP Servers) */}
          {(mcpConnections || []).length > 0 && (
            <FormField label={acf.integrations} description={acf.integrationsDesc}>
              <div className="space-y-2">
                {(mcpConnections || []).map((conn) => {
                  const integrationIds: string[] = config.integrationIds || [];
                  const integrationToolPermissions: Record<string, string[]> = config.integrationToolPermissions || {};
                  const isEnabled = integrationIds.includes(conn.id);
                  const isExpanded = expandedIntegrations.has(conn.id);
                  const discoveredTools = conn.settings?.discoveredTools || [];
                  const enabledToolNames = integrationToolPermissions[conn.id] || [];

                  return (
                    <div key={conn.id} className="rounded-lg border">
                      <div className="flex items-center justify-between p-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Switch
                            checked={isEnabled}
                            onCheckedChange={(checked) => {
                              const newIds = checked
                                ? [...integrationIds, conn.id]
                                : integrationIds.filter((id: string) => id !== conn.id);
                              const newPerms = { ...integrationToolPermissions };
                              if (checked) {
                                newPerms[conn.id] = discoveredTools.map((t) => t.name);
                                setExpandedIntegrations((s) => new Set([...s, conn.id]));
                              } else {
                                delete newPerms[conn.id];
                                setExpandedIntegrations((s) => {
                                  const next = new Set(s);
                                  next.delete(conn.id);
                                  return next;
                                });
                              }
                              onChange({ ...config, integrationIds: newIds, integrationToolPermissions: newPerms });
                            }}
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{conn.name}</p>
                            <p className="text-xs text-muted-foreground">{acf.toolsCount.replace('{count}', String(discoveredTools.length))}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {isEnabled && (
                            <Badge variant="outline" className="text-xs">
                              {enabledToolNames.length}/{discoveredTools.length}
                            </Badge>
                          )}
                          {isEnabled && discoveredTools.length > 0 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="p-1 rounded hover:bg-muted"
                              onClick={() => {
                                setExpandedIntegrations((s) => {
                                  const next = new Set(s);
                                  if (next.has(conn.id)) next.delete(conn.id);
                                  else next.add(conn.id);
                                  return next;
                                });
                              }}
                            >
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </Button>
                          )}
                        </div>
                      </div>

                      {isEnabled && isExpanded && discoveredTools.length > 0 && (
                        <div className="border-t px-3 pb-3 pt-2">
                          <div className="flex items-center justify-end gap-2 mb-2">
                            <Button
                              type="button"
                              variant="ghost"
                              className="text-xs text-primary hover:underline"
                              onClick={() =>
                                onChange({
                                  ...config,
                                  integrationToolPermissions: {
                                    ...integrationToolPermissions,
                                    [conn.id]: discoveredTools.map((t) => t.name),
                                  },
                                })
                              }
                            >
                              {acf.enableAll}
                            </Button>
                            <span className="text-muted-foreground text-xs">/</span>
                            <Button
                              type="button"
                              variant="ghost"
                              className="text-xs text-primary hover:underline"
                              onClick={() =>
                                onChange({
                                  ...config,
                                  integrationToolPermissions: {
                                    ...integrationToolPermissions,
                                    [conn.id]: [],
                                  },
                                })
                              }
                            >
                              {acf.disableAll}
                            </Button>
                          </div>
                          <div className="space-y-1.5 max-h-[180px] overflow-y-auto">
                            {discoveredTools.map((tool) => (
                              <label key={tool.name} className="flex items-start gap-2 cursor-pointer py-0.5">
                                <Checkbox
                                  checked={enabledToolNames.includes(tool.name)}
                                  onCheckedChange={(checked) => {
                                    const current = integrationToolPermissions[conn.id] || [];
                                    const updated = checked
                                      ? [...current, tool.name]
                                      : current.filter((n: string) => n !== tool.name);
                                    onChange({
                                      ...config,
                                      integrationToolPermissions: {
                                        ...integrationToolPermissions,
                                        [conn.id]: updated,
                                      },
                                    });
                                  }}
                                  className="mt-0.5"
                                />
                                <div className="min-w-0">
                                  <span className="text-sm font-mono leading-none">{tool.name}</span>
                                  {tool.description && (
                                    <p className="text-xs text-muted-foreground">{tool.description}</p>
                                  )}
                                </div>
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </FormField>
          )}

          <div className="grid grid-cols-2 gap-4">
            <FormField label={acf.maxIterations} description={acf.maxIterationsDesc}>
              <Input
                type="number"
                value={config.maxIterations || 10}
                onChange={(e) => onChange({ ...config, maxIterations: parseInt(e.target.value) || 10 })}
                min={1}
                max={50}
              />
            </FormField>
            <FormField label={acf.tokenBudget} description={acf.tokenBudgetDesc}>
              <Input
                type="number"
                value={config.maxTotalTokens || 20000}
                onChange={(e) => onChange({ ...config, maxTotalTokens: parseInt(e.target.value) || 20000 })}
                min={1000}
                max={100000}
                step={1000}
              />
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FormField label={acf.temperature} description={acf.temperatureDesc}>
              <Input
                type="number"
                value={config.temperature ?? 0.7}
                onChange={(e) => onChange({ ...config, temperature: parseFloat(e.target.value) || 0.7 })}
                min={0}
                max={2}
                step={0.1}
              />
            </FormField>
            <FormField label={acf.maxTokens} description={acf.maxTokensDesc}>
              <Input
                type="number"
                value={config.maxTokens || 1024}
                onChange={(e) => onChange({ ...config, maxTokens: parseInt(e.target.value) || 1024 })}
                min={100}
                max={16384}
              />
            </FormField>
          </div>

          <FormField label={acf.escalation} description={acf.escalationDesc}>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={config.escalationRules?.escalateOnFailure !== false}
                  onCheckedChange={(checked) =>
                    onChange({ ...config, escalationRules: { ...config.escalationRules, escalateOnFailure: !!checked } })
                  }
                />
                <span className="text-sm">{acf.escalateOnError}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={config.escalationRules?.escalateOnMaxIterations !== false}
                  onCheckedChange={(checked) =>
                    onChange({ ...config, escalationRules: { ...config.escalationRules, escalateOnMaxIterations: !!checked } })
                  }
                />
                <span className="text-sm">{acf.escalateOnMaxIterations}</span>
              </label>
            </div>
          </FormField>
        </>
      )}

      {/* Sub-Agents — available in both saved and inline modes */}
      <FormField label={acf.subAgents} description={acf.subAgentsDesc}>
        <div className="space-y-2">
          {(savedAgents || [])
            .filter((a) => a.id !== config.agentDefinitionId)
            .map((agent) => {
              const selected = (config.subAgentIds || []).includes(agent.id);
              const agentModel = AVAILABLE_MODELS.find((m) => m.value === agent.modelId);
              return (
                <div
                  key={agent.id}
                  className={cn(
                    'rounded-lg border transition-colors',
                    selected
                      ? 'border-violet-300 bg-violet-50 dark:border-violet-700 dark:bg-violet-950/30'
                      : 'border-border hover:bg-muted/50'
                  )}
                >
                  <label className="flex items-center gap-3 p-3 cursor-pointer">
                    <Checkbox
                      checked={selected}
                      onCheckedChange={(checked) => {
                        const current: string[] = config.subAgentIds || [];
                        const currentNames: Record<string, string> = config.subAgentNames || {};
                        if (checked) {
                          onChange({
                            ...config,
                            subAgentIds: [...current, agent.id],
                            subAgentNames: { ...currentNames, [agent.id]: agent.name },
                          });
                        } else {
                          const { [agent.id]: _, ...restNames } = currentNames;
                          onChange({
                            ...config,
                            subAgentIds: current.filter((id: string) => id !== agent.id),
                            subAgentNames: restNames,
                          });
                        }
                      }}
                    />
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="flex-shrink-0 w-7 h-7 rounded-md bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                        <Bot className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{agent.name}</p>
                        {agent.description && (
                          <p className="text-xs text-muted-foreground truncate">{agent.description}</p>
                        )}
                      </div>
                    </div>
                    <div className="ml-auto flex items-center gap-2 shrink-0">
                      {agent.modelId === 'inherit' && (
                        <Badge variant="secondary" className="text-xs">{acf.inheritsModel}</Badge>
                      )}
                      {agent.modelId !== 'inherit' && agentModel && (
                        <span className="text-xs text-muted-foreground">{agentModel.label}</span>
                      )}
                      <Badge variant="outline" className="text-xs">
                        {agent.moduleKey}
                      </Badge>
                    </div>
                  </label>
                </div>
              );
            })}
          {(savedAgents || []).filter((a) => a.id !== config.agentDefinitionId).length === 0 && (
            <p className="text-sm text-muted-foreground py-2">
              {acf.noAgentsAvailable}{' '}
              <a href="/welddesk/weldagent" className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer">
                {acf.createAgents}
              </a>{' '}
              {acf.createAgentsFirst}
            </p>
          )}
        </div>
      </FormField>

      {(config.subAgentIds || []).length > 0 && (
        <FormField label={acf.maxDelegationDepth} description={acf.maxDelegationDepthDesc}>
          <Input
            type="number"
            value={config.maxDelegationDepth || 3}
            onChange={(e) => onChange({ ...config, maxDelegationDepth: parseInt(e.target.value) || 3 })}
            min={1}
            max={5}
          />
        </FormField>
      )}
    </div>
  );
}

// ============================================================================
// Manual Step Form
// ============================================================================

function ManualStepForm({ config, onChange, workspaceMembers }: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
  workspaceMembers?: WorkspaceMember[];
}) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  const st = useTranslations();
  const fields: Array<{ id: string; label: string; type: string; required?: boolean }> = config.fields || [];

  const addField = () => {
    const newField = {
      id: `field_${Date.now()}`,
      label: '',
      type: 'text',
      required: false,
    };
    onChange({ ...config, fields: [...fields, newField] });
  };

  const updateField = (index: number, updates: Record<string, any>) => {
    const newFields = [...fields];
    newFields[index] = { ...newFields[index], ...updates };
    onChange({ ...config, fields: newFields });
  };

  const removeField = (index: number) => {
    onChange({ ...config, fields: fields.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-4">
      <FormField label={acf.manualTitle} description={acf.manualTitleDesc} required>
        <Input
          value={config.title || ''}
          onChange={(e) => onChange({ ...config, title: e.target.value })}
          placeholder={st('sweep.weldflow.actionConfig.manualStepTitlePlaceholder')}
        />
      </FormField>

      <FormField label={acf.description} description={acf.descriptionDesc}>
        <Textarea
          value={config.description || ''}
          onChange={(e) => onChange({ ...config, description: e.target.value })}
          placeholder={st('sweep.weldflow.actionConfig.manualStepDescriptionPlaceholder')}
          rows={3}
        />
      </FormField>

      <FormField label={acf.assignTo} description={acf.assignToDesc}>
        <Select
          value={config.assignTo || 'workflow_creator'}
          onValueChange={(v) => onChange({ ...config, assignTo: v })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="workflow_creator">{acf.assignToOptions.workflow_creator}</SelectItem>
            <SelectItem value="specific_user">{acf.assignToOptions.specific_user}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      {config.assignTo === 'specific_user' && workspaceMembers && (
        <FormField label={acf.user}>
          <Select
            value={config.assigneeId || ''}
            onValueChange={(v) => onChange({ ...config, assigneeId: v })}
          >
            <SelectTrigger><SelectValue placeholder={acf.selectUser} /></SelectTrigger>
            <SelectContent>
              {workspaceMembers.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.name} ({m.email})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}

      <FormField label={acf.actions} description={acf.actionsDesc}>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={(config.actions || ['approve', 'reject']).includes('approve')}
              onCheckedChange={(checked) => {
                const actions = config.actions || ['approve', 'reject'];
                onChange({
                  ...config,
                  actions: checked
                    ? [...new Set([...actions, 'approve'])]
                    : actions.filter((a: string) => a !== 'approve'),
                });
              }}
            />
            <span className="text-sm">{acf.approve}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={(config.actions || ['approve', 'reject']).includes('reject')}
              onCheckedChange={(checked) => {
                const actions = config.actions || ['approve', 'reject'];
                onChange({
                  ...config,
                  actions: checked
                    ? [...new Set([...actions, 'reject'])]
                    : actions.filter((a: string) => a !== 'reject'),
                });
              }}
            />
            <span className="text-sm">{acf.reject}</span>
          </label>
        </div>
      </FormField>

      <div className="grid grid-cols-2 gap-4">
        <FormField label={acf.approveButtonLabel}>
          <Input
            value={config.approveLabel || ''}
            onChange={(e) => onChange({ ...config, approveLabel: e.target.value })}
            placeholder={acf.approve}
          />
        </FormField>
        <FormField label={acf.rejectButtonLabel}>
          <Input
            value={config.rejectLabel || ''}
            onChange={(e) => onChange({ ...config, rejectLabel: e.target.value })}
            placeholder={acf.reject}
          />
        </FormField>
      </div>

      <FormField label={acf.formFields} description={acf.formFieldsDesc}>
        <div className="space-y-3">
          {fields.map((field, index) => (
            <div key={field.id} className="flex items-start gap-2 p-3 rounded-lg border">
              <div className="flex-1 space-y-2">
                <Input
                  value={field.label}
                  onChange={(e) => updateField(index, { label: e.target.value })}
                  placeholder={acf.fieldLabel}
                />
                <div className="flex gap-2">
                  <Select
                    value={field.type}
                    onValueChange={(v) => updateField(index, { type: v })}
                  >
                    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">{acf.fieldTypes.text}</SelectItem>
                      <SelectItem value="textarea">{acf.fieldTypes.textarea}</SelectItem>
                      <SelectItem value="number">{acf.fieldTypes.number}</SelectItem>
                      <SelectItem value="select">{acf.fieldTypes.select}</SelectItem>
                      <SelectItem value="checkbox">{acf.fieldTypes.checkbox}</SelectItem>
                    </SelectContent>
                  </Select>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <Checkbox
                      checked={field.required || false}
                      onCheckedChange={(checked) => updateField(index, { required: !!checked })}
                    />
                    <span className="text-xs text-muted-foreground">{acf.required}</span>
                  </label>
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => removeField(index)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addField} className="w-full">
            <Plus className="h-4 w-4 mr-1" /> {acf.addField}
          </Button>
        </div>
      </FormField>

      <FormField label={acf.notification} description={acf.notificationDesc}>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={(config.notifyVia || ['in_app']).includes('in_app')}
              onCheckedChange={(checked) => {
                const channels = config.notifyVia || ['in_app'];
                onChange({
                  ...config,
                  notifyVia: checked
                    ? [...new Set([...channels, 'in_app'])]
                    : channels.filter((c: string) => c !== 'in_app'),
                });
              }}
            />
            <span className="text-sm">{acf.inAppNotification}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={(config.notifyVia || []).includes('email')}
              onCheckedChange={(checked) => {
                const channels = config.notifyVia || ['in_app'];
                onChange({
                  ...config,
                  notifyVia: checked
                    ? [...new Set([...channels, 'email'])]
                    : channels.filter((c: string) => c !== 'email'),
                });
              }}
            />
            <span className="text-sm">{acf.emailNotification}</span>
          </label>
        </div>
      </FormField>
    </div>
  );
}

export function ActionConfigForm({
  actionType,
  config,
  onChange,
  emailAccounts = [],
  workspaceMembers = [],
  workflowSteps = [],
  currentStepIndex = 0,
  workflowVariables = [],
  triggerType,
  extraVariableGroups,
  excludeGroups,
}: ActionConfigFormProps) {
  const { t } = useI18n();
  const acf = t.weldconnect.actionConfigForm;
  // Get previous steps for variable context
  const previousSteps = workflowSteps.slice(0, currentStepIndex);

  const renderForm = () => {
    switch (actionType) {
      case 'send_email':
      case 'email':
        return (
          <SendEmailForm
            config={config}
            onChange={onChange}
            emailAccounts={emailAccounts}
            triggerType={triggerType}
            steps={previousSteps}
            workflowVariables={workflowVariables}
            extraVariableGroups={extraVariableGroups}
            excludeGroups={excludeGroups}
          />
        );

      case 'http_request':
      case 'http':
      case 'webhook':
      case 'api_call':
        return (
          <HttpRequestForm
            config={config}
            onChange={onChange}
            triggerType={triggerType}
            steps={previousSteps}
            workflowVariables={workflowVariables}
          />
        );

      case 'condition':
      case 'if':
      case 'branch':
        return (
          <ConditionForm
            config={config}
            onChange={onChange}
            workflowSteps={workflowSteps}
            currentStepIndex={currentStepIndex}
            triggerType={triggerType}
            workflowVariables={workflowVariables}
          />
        );

      case 'delay':
      case 'wait':
        return <DelayForm config={config} onChange={onChange} />;

      case 'log_message':
      case 'log':
      case 'debug':
        return (
          <LogMessageForm
            config={config}
            onChange={onChange}
            triggerType={triggerType}
            steps={previousSteps}
            workflowVariables={workflowVariables}
          />
        );

      case 'transform_data':
      case 'transform':
        return (
          <TransformDataForm
            config={config}
            onChange={onChange}
            triggerType={triggerType}
            steps={previousSteps}
            workflowVariables={workflowVariables}
          />
        );

      case 'create_record':
        return (
          <RecordForm
            config={config}
            onChange={onChange}
            triggerType={triggerType}
            steps={previousSteps}
            workflowVariables={workflowVariables}
          />
        );

      case 'update_record':
        return (
          <RecordForm
            config={config}
            onChange={onChange}
            isUpdate
            triggerType={triggerType}
            steps={previousSteps}
            workflowVariables={workflowVariables}
          />
        );

      case 'delete_record':
        return (
          <DeleteRecordForm
            config={config}
            onChange={onChange}
            triggerType={triggerType}
            steps={previousSteps}
            workflowVariables={workflowVariables}
          />
        );

      case 'query_data':
      case 'query':
        return (
          <QueryDataForm
            config={config}
            onChange={onChange}
            triggerType={triggerType}
            steps={previousSteps}
            workflowVariables={workflowVariables}
          />
        );

      case 'loop':
      case 'iterate':
        return (
          <LoopForm
            config={config}
            onChange={onChange}
            workflowSteps={workflowSteps}
            currentStepIndex={currentStepIndex}
            triggerType={triggerType}
            workflowVariables={workflowVariables}
          />
        );

      case 'set_variable':
      case 'assign':
        return (
          <SetVariableForm
            config={config}
            onChange={onChange}
            triggerType={triggerType}
            steps={previousSteps}
            workflowVariables={workflowVariables}
          />
        );

      case 'send_notification':
      case 'notification':
        return (
          <SendNotificationForm
            config={config}
            onChange={onChange}
            triggerType={triggerType}
            steps={previousSteps}
            workflowVariables={workflowVariables}
            workspaceMembers={workspaceMembers}
          />
        );

      // Helpdesk actions
      case 'assign_conversation':
        return <AssignConversationForm config={config} onChange={onChange} workspaceMembers={workspaceMembers} />;
      case 'tag_conversation':
        return <TagConversationForm config={config} onChange={onChange} />;
      case 'change_conversation_status':
        return <ChangeConversationStatusForm config={config} onChange={onChange} />;
      case 'change_priority':
        return <ChangePriorityForm config={config} onChange={onChange} />;
      case 'send_reply':
        return <SendReplyForm config={config} onChange={onChange} />;
      case 'add_internal_note':
        return <AddInternalNoteForm config={config} onChange={onChange} />;
      case 'create_ticket_from_conversation':
        return <CreateTicketFromConversationForm config={config} onChange={onChange} />;
      case 'apply_sla':
        return <ApplySlaForm config={config} onChange={onChange} />;
      case 'trigger_csat':
        return <TriggerCsatForm config={config} onChange={onChange} />;
      case 'ai_auto_reply':
        // AI has been removed platform-wide — this step type can no longer
        // be configured. <AiAutoReplyForm> is left defined but unreachable.
        return <AiUnavailable variant="inline" />;

      // Re-enabled AI action types (see apps/workers/workflow-worker/src/engine/actions/ai.ts).
      // Only these two — ai_extract/ai_summarize/ai_auto_reply/ai_agent stay unavailable.
      case 'ai_generate':
        return (
          <AiGenerateForm
            config={config}
            onChange={onChange}
            triggerType={triggerType}
            steps={previousSteps}
            workflowVariables={workflowVariables}
            extraVariableGroups={extraVariableGroups}
            excludeGroups={excludeGroups}
          />
        );
      case 'ai_classify':
        return (
          <AiClassifyForm
            config={config}
            onChange={onChange}
            triggerType={triggerType}
            steps={previousSteps}
            workflowVariables={workflowVariables}
            extraVariableGroups={extraVariableGroups}
            excludeGroups={excludeGroups}
          />
        );

      // Chat widget interactive steps
      case 'send_message':
        return <SendBotMessageForm config={config} onChange={onChange} />;
      case 'send_choices':
        return <SendChoicesForm config={config} onChange={onChange} />;
      case 'collect_input':
        return <CollectInputForm config={config} onChange={onChange} />;
      case 'collect_customer_info':
        return <CollectCustomerInfoForm config={config} onChange={onChange} />;

      // AI Agent — AI has been removed platform-wide, this step type can no
      // longer be configured. <AiAgentForm> is left defined but unreachable.
      case 'ai_agent':
        return <AiUnavailable variant="inline" />;

      // Human-in-the-loop
      case 'manual_step':
        return <ManualStepForm config={config} onChange={onChange} workspaceMembers={workspaceMembers} />;

      // Attribute setters — pick a definition instead of hand-editing JSON.
      case 'set_contact_attribute':
        return <SetAttributeForm config={config} onChange={onChange} entityType="person" acf={acf} />;
      case 'set_conversation_attribute':
        return <SetAttributeForm config={config} onChange={onChange} entityType="conversation" acf={acf} />;

      default:
        // Generic JSON editor as fallback
        return (
          <FormField label={acf.configurationJson}>
            <Textarea
              value={JSON.stringify(config, null, 2)}
              onChange={(e) => {
                try {
                  onChange(JSON.parse(e.target.value));
                } catch {
                  // Invalid JSON, ignore
                }
              }}
              placeholder="{}"
              rows={10}
              className="font-mono text-sm"
            />
          </FormField>
        );
    }
  };

  return <div className="space-y-4">{renderForm()}</div>;
}
