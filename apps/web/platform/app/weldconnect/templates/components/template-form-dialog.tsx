import { useEffect, useId, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import {
  WORKFLOW_TEMPLATE_CATEGORIES,
  type WorkflowTemplateCategory,
} from '@weldsuite/app-api-client/schemas/weldconnect-templates';
import { useI18n } from '@/lib/i18n/provider';

export interface TemplateFormValues {
  name: string;
  description: string;
  category: WorkflowTemplateCategory;
}

const NAME_MAX_LENGTH = 255;

export function toTemplateCategory(value: string | null | undefined): WorkflowTemplateCategory {
  return (WORKFLOW_TEMPLATE_CATEGORIES as readonly string[]).includes(value ?? '')
    ? (value as WorkflowTemplateCategory)
    : 'custom';
}

interface TemplateFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  initialValues: TemplateFormValues;
  submitLabel: string;
  submittingLabel: string;
  isSubmitting: boolean;
  onSubmit: (values: TemplateFormValues) => void;
}

/** Name, description and category of a workspace template: "Save as template" and "Edit details". */
export function TemplateFormDialog({
  open,
  onOpenChange,
  title,
  description,
  initialValues,
  submitLabel,
  submittingLabel,
  isSubmitting,
  onSubmit,
}: Readonly<TemplateFormDialogProps>) {
  const { t } = useI18n();
  const tf = t.weldconnect.templates.form;
  const categories = t.weldconnect.templates.categories;
  const nameId = useId();
  const descriptionId = useId();
  const categoryId = useId();
  const [values, setValues] = useState<TemplateFormValues>(initialValues);
  const [nameError, setNameError] = useState(false);

  // Start from the given values every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setValues(initialValues);
    setNameError(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const name = values.name.trim();
    if (!name) {
      setNameError(true);
      return;
    }
    onSubmit({ ...values, name, description: values.description.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={isSubmitting ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor={nameId}>{tf.nameLabel}</Label>
            <Input
              id={nameId}
              value={values.name}
              maxLength={NAME_MAX_LENGTH}
              placeholder={tf.namePlaceholder}
              aria-invalid={nameError}
              onChange={(e) => {
                setValues((prev) => ({ ...prev, name: e.target.value }));
                if (nameError) setNameError(false);
              }}
            />
            {nameError && <p className="text-xs text-destructive">{tf.nameRequired}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor={descriptionId}>{tf.descriptionLabel}</Label>
            <Textarea
              id={descriptionId}
              value={values.description}
              rows={3}
              placeholder={tf.descriptionPlaceholder}
              onChange={(e) => setValues((prev) => ({ ...prev, description: e.target.value }))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={categoryId}>{tf.categoryLabel}</Label>
            <Select
              value={values.category}
              onValueChange={(category) => setValues((prev) => ({ ...prev, category: toTemplateCategory(category) }))}
            >
              <SelectTrigger id={categoryId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORKFLOW_TEMPLATE_CATEGORIES.map((category) => (
                  <SelectItem key={category} value={category}>
                    {categories[category]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              {t.common.actions.cancel}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  {submittingLabel}
                </>
              ) : (
                submitLabel
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
