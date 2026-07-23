import { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  useCreateReconciliationRule,
  useUpdateReconciliationRule,
  useAccountingAccounts,
  useAccountingTaxRates,
  useAccountingCustomers,
} from '@/hooks/queries/use-accounting-queries';
import type {
  ReconciliationRule,
  ReconciliationRuleCondition,
} from '@/lib/api/domains/weldbooks';

const FIELD_VALUES: Array<{ value: ReconciliationRuleCondition['field']; type: 'text' | 'number' }> = [
  { value: 'description', type: 'text' },
  { value: 'counterpartyName', type: 'text' },
  { value: 'counterpartyIban', type: 'text' },
  { value: 'reference', type: 'text' },
  { value: 'amount', type: 'number' },
];

const TEXT_OPERATORS = ['contains', 'equals', 'starts_with', 'ends_with'] as const;
const NUMBER_OPERATORS = ['equals', 'greater_than', 'less_than', 'between'] as const;

interface RuleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule?: ReconciliationRule | null;
}

function newEmptyCondition(): ReconciliationRuleCondition {
  return { field: 'description', operator: 'contains', value: '' };
}

export function ReconciliationRuleFormDialog({
  open,
  onOpenChange,
  rule,
}: RuleFormDialogProps) {
  const st = useTranslations();
  const isEdit = !!rule;

  const FIELDS: Array<{ value: ReconciliationRuleCondition['field']; label: string; type: 'text' | 'number' }> =
    FIELD_VALUES.map((f) => ({
      ...f,
      label: st(`sweep.weldbooks.reconciliationRuleForm.field.${f.value}`),
    }));

  const OPERATOR_LABELS: Record<string, string> = {
    contains: st('sweep.weldbooks.reconciliationRuleForm.operator.contains'),
    equals: st('sweep.weldbooks.reconciliationRuleForm.operator.equals'),
    starts_with: st('sweep.weldbooks.reconciliationRuleForm.operator.startsWith'),
    ends_with: st('sweep.weldbooks.reconciliationRuleForm.operator.endsWith'),
    greater_than: st('sweep.weldbooks.reconciliationRuleForm.operator.greaterThan'),
    less_than: st('sweep.weldbooks.reconciliationRuleForm.operator.lessThan'),
    between: st('sweep.weldbooks.reconciliationRuleForm.operator.between'),
  };

  const [name, setName] = useState('');
  const [priority, setPriority] = useState(0);
  const [matchMode, setMatchMode] = useState<'all' | 'any'>('all');
  const [isActive, setIsActive] = useState(true);
  const [conditions, setConditions] = useState<ReconciliationRuleCondition[]>([
    newEmptyCondition(),
  ]);
  const [categoryAccountId, setCategoryAccountId] = useState<string>('');
  const [taxRateId, setTaxRateId] = useState<string>('');
  const [contactId, setContactId] = useState<string>('');
  const [descriptionOverride, setDescriptionOverride] = useState('');

  const { data: accountsRes } = useAccountingAccounts();
  const { data: taxRatesRes } = useAccountingTaxRates();
  const { data: contactsRes } = useAccountingCustomers({ pageSize: 100 });

  const accountOptions = ((accountsRes?.data ?? []) as any[]).filter(
    (a) => a.type === 'expense' || a.type === 'revenue',
  );
  const taxRateOptions = (taxRatesRes?.data ?? []) as any[];
  const contactOptions = (contactsRes?.data ?? []) as any[];

  useEffect(() => {
    if (!open) return;
    if (rule) {
      setName(rule.name ?? '');
      setPriority(rule.priority ?? 0);
      setMatchMode(rule.matchMode ?? 'all');
      setIsActive(rule.isActive !== false);
      setConditions(
        rule.conditions && rule.conditions.length > 0
          ? rule.conditions
          : [newEmptyCondition()],
      );
      setCategoryAccountId(rule.actions?.categoryAccountId ?? '');
      setTaxRateId(rule.actions?.taxRateId ?? '');
      setContactId(rule.actions?.contactId ?? '');
      setDescriptionOverride(rule.actions?.description ?? '');
    } else {
      setName('');
      setPriority(0);
      setMatchMode('all');
      setIsActive(true);
      setConditions([newEmptyCondition()]);
      setCategoryAccountId('');
      setTaxRateId('');
      setContactId('');
      setDescriptionOverride('');
    }
  }, [open, rule]);

  const createMutation = useCreateReconciliationRule();
  const updateMutation = useUpdateReconciliationRule();
  const pending = createMutation.isPending || updateMutation.isPending;
  const errorMessage =
    (createMutation.error as Error | null)?.message ??
    (updateMutation.error as Error | null)?.message ??
    null;

  const actionsEmpty =
    !categoryAccountId && !taxRateId && !contactId && !descriptionOverride;
  const conditionsInvalid = conditions.some(
    (c) => c.value === '' || c.value === null || c.value === undefined,
  );
  const canSubmit = !!name && !actionsEmpty && !conditionsInvalid && !pending;

  const updateCondition = (idx: number, patch: Partial<ReconciliationRuleCondition>) => {
    setConditions((prev) =>
      prev.map((c, i) => (i === idx ? ({ ...c, ...patch } as ReconciliationRuleCondition) : c)),
    );
  };

  const addCondition = () => setConditions((prev) => [...prev, newEmptyCondition()]);
  const removeCondition = (idx: number) =>
    setConditions((prev) => prev.filter((_, i) => i !== idx));

  const handleSubmit = () => {
    const payload = {
      name,
      priority,
      matchMode,
      isActive,
      conditions: conditions.map((c) => ({
        ...c,
        // coerce numeric fields stored as strings in inputs
        value: c.field === 'amount' ? Number(c.value) : c.value,
        ...(c.operator === 'between' && c.value2 !== undefined
          ? { value2: Number(c.value2) }
          : {}),
      })),
      actions: {
        ...(categoryAccountId ? { categoryAccountId } : {}),
        ...(taxRateId ? { taxRateId } : {}),
        ...(contactId ? { contactId } : {}),
        ...(descriptionOverride ? { description: descriptionOverride } : {}),
      },
    };
    if (isEdit && rule) {
      updateMutation.mutate(
        { id: rule.id, data: payload },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      createMutation.mutate(payload, { onSuccess: () => onOpenChange(false) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? st('sweep.weldbooks.reconciliationRuleForm.editTitle') : st('sweep.weldbooks.reconciliationRuleForm.newTitle')}</DialogTitle>
          <DialogDescription>
            {st('sweep.weldbooks.reconciliationRuleForm.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Label htmlFor="rule-name">{st('sweep.weldbooks.name')}</Label>
              <Input
                id="rule-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Office rent"
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="rule-priority">{st('sweep.weldbooks.reconciliationRuleForm.priorityLabel')}</Label>
              <Input
                id="rule-priority"
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            </div>
          </div>

          <div>
            <Label>{st('sweep.weldbooks.reconciliationRuleForm.matchModeLabel')}</Label>
            <RadioGroup
              value={matchMode}
              onValueChange={(v) => setMatchMode(v as 'all' | 'any')}
              className="flex gap-4 mt-1"
            >
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="all" />
                {st('sweep.weldbooks.reconciliationRuleForm.matchAll')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="any" />
                {st('sweep.weldbooks.reconciliationRuleForm.matchAny')}
              </label>
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label>{st('sweep.weldbooks.reconciliationRuleForm.conditionsLabel')}</Label>
            {conditions.map((c, idx) => {
              const fieldDef = FIELDS.find((f) => f.value === c.field)!;
              const operators = fieldDef.type === 'number' ? NUMBER_OPERATORS : TEXT_OPERATORS;
              return (
                <div key={idx} className="flex items-start gap-2">
                  <Select
                    value={c.field}
                    onValueChange={(v) => {
                      const newField = v as ReconciliationRuleCondition['field'];
                      const newDef = FIELDS.find((f) => f.value === newField)!;
                      const validOps =
                        newDef.type === 'number' ? NUMBER_OPERATORS : TEXT_OPERATORS;
                      updateCondition(idx, {
                        field: newField,
                        operator: validOps.includes(c.operator as any)
                          ? c.operator
                          : validOps[0],
                        value: '',
                        value2: undefined,
                      });
                    }}
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELDS.map((f) => (
                        <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={c.operator}
                    onValueChange={(v) =>
                      updateCondition(idx, {
                        operator: v as ReconciliationRuleCondition['operator'],
                        value2: v === 'between' ? c.value2 ?? 0 : undefined,
                      })
                    }
                  >
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {operators.map((op) => (
                        <SelectItem key={op} value={op}>
                          {OPERATOR_LABELS[op]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type={fieldDef.type === 'number' ? 'number' : 'text'}
                    value={String(c.value ?? '')}
                    onChange={(e) =>
                      updateCondition(idx, { value: e.target.value })
                    }
                    placeholder={st('sweep.weldbooks.reconciliationRuleForm.valuePlaceholder')}
                    className="flex-1"
                  />
                  {c.operator === 'between' ? (
                    <Input
                      type="number"
                      value={String(c.value2 ?? '')}
                      onChange={(e) =>
                        updateCondition(idx, { value2: Number(e.target.value) })
                      }
                      placeholder={st('sweep.weldbooks.reconciliationRuleForm.andPlaceholder')}
                      className="w-28"
                    />
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeCondition(idx)}
                    disabled={conditions.length === 1}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
            <Button variant="outline" size="sm" onClick={addCondition}>
              <Plus className="h-4 w-4 mr-1" />
              {st('sweep.weldbooks.reconciliationRuleForm.addCondition')}
            </Button>
          </div>

          <div className="space-y-2 border-t pt-4">
            <div>
              <Label>{st('sweep.weldbooks.reconciliationRuleForm.actionsLabel')}</Label>
              <p className="text-xs text-muted-foreground">
                {st('sweep.weldbooks.reconciliationRuleForm.actionsDescription')}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">{st('sweep.weldbooks.reconciliationRuleForm.categoryAccountLabel')}</Label>
                <Select value={categoryAccountId} onValueChange={setCategoryAccountId}>
                  <SelectTrigger>
                    <SelectValue placeholder={st('sweep.weldbooks.reconciliationRuleForm.nonePlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {accountOptions.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">{st('sweep.weldbooks.reconciliationRuleForm.taxRateLabel')}</Label>
                <Select value={taxRateId} onValueChange={setTaxRateId}>
                  <SelectTrigger>
                    <SelectValue placeholder={st('sweep.weldbooks.reconciliationRuleForm.nonePlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {taxRateOptions.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} ({t.rate}%)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">{st('sweep.weldbooks.reconciliationRuleForm.contactLabel')}</Label>
                <Select value={contactId} onValueChange={setContactId}>
                  <SelectTrigger>
                    <SelectValue placeholder={st('sweep.weldbooks.reconciliationRuleForm.nonePlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {contactOptions.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.companyName || c.fullName || c.email || c.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">{st('sweep.weldbooks.reconciliationRuleForm.descriptionOverrideLabel')}</Label>
                <Input
                  value={descriptionOverride}
                  onChange={(e) => setDescriptionOverride(e.target.value)}
                  placeholder={st('sweep.weldbooks.reconciliationRuleForm.optionalPlaceholder')}
                />
              </div>
            </div>
            {actionsEmpty ? (
              <p className="text-xs text-muted-foreground">
                {st('sweep.weldbooks.reconciliationRuleForm.actionsEmptyHint')}
              </p>
            ) : null}
          </div>

          <label className="flex items-center gap-2 border-t pt-4">
            <Checkbox checked={isActive} onCheckedChange={(v) => setIsActive(!!v)} />
            <span className="text-sm">{st('sweep.weldbooks.reconciliationRuleForm.activeLabel')}</span>
          </label>
        </div>

        {errorMessage ? (
          <p className="text-sm text-destructive">{errorMessage}</p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {st('sweep.weldbooks.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {pending ? (
              <><Loader2 className="h-4 w-4 mr-1 animate-spin" />{st('sweep.weldbooks.saving')}</>
            ) : isEdit ? (
              st('sweep.weldbooks.reconciliationRuleForm.saveRule')
            ) : (
              st('sweep.weldbooks.reconciliationRuleForm.createRule')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
