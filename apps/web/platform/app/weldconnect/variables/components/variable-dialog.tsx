
import { useState, useEffect } from 'react';
import { useI18n } from '@/lib/i18n/provider';
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
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { toast } from 'sonner';
import { useCreateVariable, useUpdateVariable } from '@/hooks/queries/use-automation-queries';
import { RefreshCw, Eye, EyeOff, AlertCircle } from 'lucide-react';
import type { Variable } from './variables-client';

interface VariableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variable?: Variable; // If provided, it's edit mode
  mode?: 'create' | 'edit';
}

type VariablesTranslations = ReturnType<typeof useI18n>['t']['weldconnect']['variables'];

interface VariableFormFields {
  name: string;
  value: string;
  confirmValue: string;
  description: string;
  isSecret: boolean;
}

function getValidationError(
  mode: 'create' | 'edit',
  form: VariableFormFields,
  toasts: VariablesTranslations['toastsDialog'],
): string | null {
  if (mode === 'create') {
    if (!form.name.trim()) return toasts.nameRequired;
    if (!form.value.trim()) return toasts.valueRequired;
    if (form.isSecret && form.value !== form.confirmValue) return toasts.valuesMismatch;
    return null;
  }
  if (!form.value.trim() && !form.description.trim()) return toasts.updateRequiresChange;
  return null;
}

function buildUpdateData(value: string, description: string): { value?: string; description?: string } {
  const updateData: { value?: string; description?: string } = {};
  if (value.trim()) updateData.value = value;
  if (description.trim()) updateData.description = description;
  return updateData;
}

function buildCreateData(form: {
  name: string;
  value: string;
  description: string;
  isSecret: boolean;
  scope: string;
  workflowId: string;
}) {
  return {
    name: form.name.trim(),
    value: form.value.trim(),
    description: form.description.trim() || undefined,
    isSecret: form.isSecret,
    isGlobal: form.scope === 'global',
    workflowId: form.scope === 'workflow' && form.workflowId ? form.workflowId : undefined,
  };
}

function VisibilityIcon({ shown }: Readonly<{ shown: boolean }>) {
  return shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />;
}

function SubmitLabel({
  isPending,
  mode,
  isSecret,
  dialog,
}: Readonly<{
  isPending: boolean;
  mode: 'create' | 'edit';
  isSecret: boolean;
  dialog: VariablesTranslations['dialog'];
}>) {
  if (isPending) {
    return (
      <>
        <RefreshCw className="h-4 w-4 mr-0.5 animate-spin" />
        {mode === 'edit' ? dialog.updating : dialog.creating}
      </>
    );
  }
  if (mode === 'edit') return <>{dialog.update}</>;
  return <>{dialog.create.replace('{type}', isSecret ? dialog.secret : dialog.variable)}</>;
}

export function VariableDialog({ open, onOpenChange, variable, mode = 'create' }: Readonly<VariableDialogProps>) {
  const { t } = useI18n();
  const createVariableMutation = useCreateVariable();
  const updateVariableMutation = useUpdateVariable();
  const isPending = createVariableMutation.isPending || updateVariableMutation.isPending;
  const [showValue, setShowValue] = useState(false);
  const [showConfirmValue, setShowConfirmValue] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [confirmValue, setConfirmValue] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState('global');
  const [workflowId, setWorkflowId] = useState('');
  const [isSecret, setIsSecret] = useState(false);

  // Initialize form when variable changes (edit mode)
  useEffect(() => {
    if (variable && mode === 'edit') {
      setName(variable.name || '');
      setValue(''); // Don't pre-fill value for security
      setDescription(variable.description || '');
      setScope(variable.scope || 'global');
      setWorkflowId(variable.workflowId || '');
      setIsSecret(variable.isSecret || false);
    } else {
      // Reset form for create mode
      setName('');
      setValue('');
      setConfirmValue('');
      setDescription('');
      setScope('global');
      setWorkflowId('');
      setIsSecret(false);
    }
  }, [variable, mode, open]);

  const resetForm = () => {
    setName('');
    setValue('');
    setConfirmValue('');
    setDescription('');
    setScope('global');
    setWorkflowId('');
    setIsSecret(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const validationError = getValidationError(
      mode,
      { name, value, confirmValue, description, isSecret },
      t.weldconnect.variables.toastsDialog,
    );
    if (validationError !== null) {
      toast.error(validationError);
      return;
    }

    if (mode === 'edit' && variable) {
      // Update existing variable
      updateVariableMutation.mutate({ id: variable.id, data: buildUpdateData(value, description) }, {
        onSuccess: () => {
          toast.success(t.weldconnect.variables.toastsDialog.updated);
          onOpenChange(false);
        },
        onError: () => {
          toast.error(t.weldconnect.variables.toastsDialog.updateFailed);
        },
      });
    } else {
      // Create new variable (use isSecret flag in the data)
      const data = buildCreateData({ name, value, description, isSecret, scope, workflowId });

      const entityType = isSecret ? t.weldconnect.variables.dialog.secret : t.weldconnect.variables.dialog.variable;

      createVariableMutation.mutate(data, {
        onSuccess: () => {
          toast.success(t.weldconnect.variables.toastsDialog.created.replace('{type}', entityType));
          onOpenChange(false);

          resetForm();
        },
        onError: () => {
          toast.error(t.weldconnect.variables.toastsDialog.createFailed.replace('{type}', entityType));
        },
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {mode === 'edit'
              ? t.weldconnect.variables.dialog.editTitle.replace('{name}', variable?.name || '')
              : t.weldconnect.variables.dialog.createTitle}
          </DialogTitle>
          <DialogDescription>
            {mode === 'edit'
              ? t.weldconnect.variables.dialog.editDescription
              : t.weldconnect.variables.dialog.createDescription}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          {/* Name (Create mode only) */}
          {mode === 'create' && (
            <div className="space-y-2">
              <Label htmlFor="name">
                {t.weldconnect.variables.dialog.nameLabel} <span className="text-red-500">*</span>
              </Label>
              <Input
                id="name"
                placeholder={t.weldconnect.variables.dialog.namePlaceholder}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isPending}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                {t.weldconnect.variables.dialog.nameHint}
              </p>
            </div>
          )}

          {/* Scope (Create mode only) */}
          {mode === 'create' && (
            <div className="space-y-2">
              <Label htmlFor="scope">
                {t.weldconnect.variables.dialog.scopeLabel} <span className="text-red-500">*</span>
              </Label>
              <Select value={scope} onValueChange={setScope} disabled={isPending}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">
                    <div>
                      <div className="font-medium">{t.weldconnect.variables.scopes.global}</div>
                      <div className="text-xs text-muted-foreground">
                        {t.weldconnect.variables.scopeDescriptions.global}
                      </div>
                    </div>
                  </SelectItem>
                  <SelectItem value="workflow">
                    <div>
                      <div className="font-medium">{t.weldconnect.variables.scopes.workflow}</div>
                      <div className="text-xs text-muted-foreground">
                        {t.weldconnect.variables.scopeDescriptions.workflow}
                      </div>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Workflow ID (if workflow scope) */}
          {mode === 'create' && scope === 'workflow' && (
            <div className="space-y-2">
              <Label htmlFor="workflowId">
                {t.weldconnect.variables.dialog.workflowIdLabel} <span className="text-red-500">*</span>
              </Label>
              <Input
                id="workflowId"
                placeholder={t.weldconnect.variables.dialog.workflowIdPlaceholder}
                value={workflowId}
                onChange={(e) => setWorkflowId(e.target.value)}
                disabled={isPending}
              />
              <p className="text-xs text-muted-foreground">
                {t.weldconnect.variables.dialog.workflowIdHint}
              </p>
            </div>
          )}

          {/* Is Secret Toggle (Create mode only) */}
          {mode === 'create' && (
            <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
              <div className="space-y-0.5">
                <Label htmlFor="isSecret">{t.weldconnect.variables.dialog.secretToggleLabel}</Label>
                <div className="text-xs text-muted-foreground">
                  {t.weldconnect.variables.dialog.secretToggleHint}
                </div>
              </div>
              <Switch
                id="isSecret"
                checked={isSecret}
                onCheckedChange={setIsSecret}
                disabled={isPending}
              />
            </div>
          )}

          {/* Value */}
          <div className="space-y-2">
            <Label htmlFor="value">
              {mode === 'edit' ? t.weldconnect.variables.dialog.newValueLabel : t.weldconnect.variables.dialog.valueLabel}{' '}
              {mode === 'create' && <span className="text-red-500">*</span>}
            </Label>
            <div className="relative">
              <Input
                id="value"
                type={isSecret && !showValue ? 'password' : 'text'}
                placeholder={mode === 'edit' ? t.weldconnect.variables.dialog.valueEditPlaceholder : t.weldconnect.variables.dialog.valuePlaceholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={isPending}
                className="font-mono pr-10"
              />
              {isSecret && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 p-0"
                  onClick={() => setShowValue(!showValue)}
                  disabled={isPending}
                >
                  <VisibilityIcon shown={showValue} />
                </Button>
              )}
            </div>
            {mode === 'edit' && (
              <p className="text-xs text-muted-foreground">
                {t.weldconnect.variables.dialog.valueHint}
              </p>
            )}
          </div>

          {/* Confirm Value (for secrets in create mode) */}
          {mode === 'create' && isSecret && (
            <div className="space-y-2">
              <Label htmlFor="confirmValue">
                {t.weldconnect.variables.dialog.confirmValueLabel} <span className="text-red-500">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="confirmValue"
                  type={showConfirmValue ? 'text' : 'password'}
                  placeholder={t.weldconnect.variables.dialog.confirmValuePlaceholder}
                  value={confirmValue}
                  onChange={(e) => setConfirmValue(e.target.value)}
                  disabled={isPending}
                  className="font-mono pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 p-0"
                  onClick={() => setShowConfirmValue(!showConfirmValue)}
                  disabled={isPending}
                >
                  <VisibilityIcon shown={showConfirmValue} />
                </Button>
              </div>
              {value && confirmValue && value !== confirmValue && (
                <div className="flex items-center gap-2 text-xs text-red-600">
                  <AlertCircle className="h-3 w-3" />
                  {t.weldconnect.variables.dialog.valuesMismatch}
                </div>
              )}
            </div>
          )}

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">{t.weldconnect.variables.dialog.descriptionLabel}</Label>
            <Textarea
              id="description"
              placeholder={t.weldconnect.variables.dialog.descriptionPlaceholder}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isPending}
              rows={3}
            />
          </div>

          {/* Info box for edit mode */}
          {mode === 'edit' && variable?.isSecret && (
            <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-4 border border-yellow-200 dark:border-yellow-800">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5" />
                <div>
                  <h4 className="font-semibold text-yellow-900 dark:text-yellow-100 mb-1">
                    {t.weldconnect.variables.dialog.encryptedVariable}
                  </h4>
                  <p className="text-sm text-yellow-700 dark:text-yellow-300">
                    {t.weldconnect.variables.dialog.encryptedVariableDescription}
                  </p>
                </div>
              </div>
            </div>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {t.weldconnect.variables.dialog.cancel}
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            <SubmitLabel isPending={isPending} mode={mode} isSecret={isSecret} dialog={t.weldconnect.variables.dialog} />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
