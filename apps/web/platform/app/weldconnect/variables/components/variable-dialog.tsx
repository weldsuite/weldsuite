
import { useState, useEffect } from 'react';
import { useRouter } from '@/lib/router';
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

interface VariableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variable?: any; // If provided, it's edit mode
  mode?: 'create' | 'edit';
}

export function VariableDialog({ open, onOpenChange, variable, mode = 'create' }: VariableDialogProps) {
  const { t } = useI18n();
  const router = useRouter();
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validation
    if (mode === 'create' && !name.trim()) {
      toast.error(t.weldconnect.variables.toastsDialog.nameRequired);
      return;
    }

    if (mode === 'create' && !value.trim()) {
      toast.error(t.weldconnect.variables.toastsDialog.valueRequired);
      return;
    }

    if (mode === 'create' && isSecret && value !== confirmValue) {
      toast.error(t.weldconnect.variables.toastsDialog.valuesMismatch);
      return;
    }

    if (mode === 'edit' && !value.trim() && !description.trim()) {
      toast.error(t.weldconnect.variables.toastsDialog.updateRequiresChange);
      return;
    }

    if (mode === 'edit') {
      // Update existing variable
      const updateData: any = {};
      if (value.trim()) updateData.value = value;
      if (description.trim()) updateData.description = description;

      updateVariableMutation.mutate({ id: variable.id, data: updateData }, {
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
      const data = {
        name: name.trim(),
        value: value.trim(),
        description: description.trim() || undefined,
        isSecret: isSecret,
        isGlobal: scope === 'global',
        workflowId: scope === 'workflow' && workflowId ? workflowId : undefined,
      };

      const entityType = isSecret ? t.weldconnect.variables.dialog.secret : t.weldconnect.variables.dialog.variable;

      createVariableMutation.mutate(data, {
        onSuccess: () => {
          toast.success(t.weldconnect.variables.toastsDialog.created.replace('{type}', entityType));
          onOpenChange(false);

          // Reset form
          setName('');
          setValue('');
          setConfirmValue('');
          setDescription('');
          setScope('global');
          setWorkflowId('');
          setIsSecret(false);
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
                  {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
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
                  {showConfirmValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
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
            {isPending ? (
              <>
                <RefreshCw className="h-4 w-4 mr-0.5 animate-spin" />
                {mode === 'edit' ? t.weldconnect.variables.dialog.updating : t.weldconnect.variables.dialog.creating}
              </>
            ) : mode === 'edit' ? (
              t.weldconnect.variables.dialog.update
            ) : (
              t.weldconnect.variables.dialog.create.replace('{type}', isSecret ? t.weldconnect.variables.dialog.secret : t.weldconnect.variables.dialog.variable)
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
