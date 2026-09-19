export { cn } from './cn';
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './button';
export { Input, type InputProps } from './input';
export { Select, type SelectProps } from './select';
export { Textarea, type TextareaProps } from './textarea';
export { Label, type LabelProps } from './label';
export { Badge, type BadgeProps, type BadgeVariant } from './badge';
export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TablePrimary,
  TableMuted,
} from './table';
export { Page, PageHeader, type PageHeaderProps, type PageProps } from './page';
export { EmptyState, type EmptyStateProps } from './empty-state';
export { Alert, type AlertProps, type AlertVariant } from './alert';
export { Toolbar, type ToolbarProps } from './toolbar';
export { FormField, FormFieldRow, Form, FormActions, type FormFieldProps } from './form-field';
export {
  DescriptionList,
  DescriptionItem,
  Code,
  Stack,
  Muted,
  LoadingState,
} from './misc';

/** Map product/status strings to Badge variants used by platform commerce. */
export function statusBadgeVariant(
  status: string | null | undefined,
): 'default' | 'outline' | 'secondary' {
  if (status === 'active') return 'default';
  if (status === 'draft') return 'outline';
  return 'secondary';
}
