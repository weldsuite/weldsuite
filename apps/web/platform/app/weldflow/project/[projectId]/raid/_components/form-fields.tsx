/**
 * Field building blocks of the RAID dialogs, generic over the form: text,
 * number, date, select and checkbox inputs wired to React Hook Form with
 * `Controller` and laid out with the shadcn `Field` components. Number, date
 * and select fields can also be property rows (`inline`): the label on the
 * left, the control on the right.
 */

import { useId, type ReactNode } from 'react';
import { Controller, type Control, type FieldPath, type FieldValues } from 'react-hook-form';
import { format, isValid, parse } from 'date-fns';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { DatePicker } from '@weldsuite/ui/components/date-picker';
import { Field, FieldDescription, FieldError, FieldLabel } from '@weldsuite/ui/components/field';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useDateLocale } from '@/lib/i18n/date-locale';
import { useI18n } from '@/lib/i18n/provider';

/** Radix selects cannot hold an empty string, so "none" is this value. */
export const NONE = '__none__';

/** The width of the control in a property row, so the controls line up. */
export const ROW_CONTROL = 'w-48';

interface BaseFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  description?: string;
  /** Lays the field out as a property row: the label on the left, the control on the right. */
  inline?: boolean;
}

/** The ids of a field's control and description, for `htmlFor` and `aria-describedby`. */
export function useFieldIds(description: string | undefined) {
  const id = useId();
  return { id, descriptionId: description ? `${id}-description` : undefined };
}

interface FieldFrameProps {
  id: string;
  descriptionId?: string;
  label: string;
  description?: string;
  error?: { message?: string };
  inline?: boolean;
  children: ReactNode;
}

/**
 * A shadcn `Field` around one control: label, control, description and error.
 * A property row puts the label left of the control, with the description and
 * error below the row.
 */
export function FieldFrame({ id, descriptionId, label, description, error, inline, children }: Readonly<FieldFrameProps>) {
  const invalid = error !== undefined;
  const notes = (
    <>
      {description ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
      <FieldError errors={[error]} />
    </>
  );
  if (!inline) {
    return (
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {children}
        {notes}
      </Field>
    );
  }
  const row = (
    <Field orientation="horizontal" data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children}
    </Field>
  );
  if (!description && !invalid) return row;
  return (
    <Field data-invalid={invalid}>
      {row}
      {notes}
    </Field>
  );
}

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  placeholder,
  autoFocus,
}: Readonly<BaseFieldProps<T> & { placeholder?: string; autoFocus?: boolean }>) {
  const { id, descriptionId } = useFieldIds(description);
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldFrame id={id} descriptionId={descriptionId} label={label} description={description} error={fieldState.error}>
          <Input
            {...field}
            id={id}
            value={(field.value as string | null | undefined) ?? ''}
            placeholder={placeholder}
            autoFocus={autoFocus}
            aria-invalid={fieldState.invalid}
            aria-describedby={descriptionId}
          />
        </FieldFrame>
      )}
    />
  );
}

const DATE_VALUE = 'yyyy-MM-dd';

/** A date picker whose value is a `yyyy-MM-dd` string, empty while no date is set. */
export function DateField<T extends FieldValues>({ control, name, label, description, inline }: Readonly<BaseFieldProps<T>>) {
  const { t } = useI18n();
  const { dateFnsLocale } = useDateLocale();
  const { id, descriptionId } = useFieldIds(description);
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const parsed = field.value ? parse(field.value as string, DATE_VALUE, new Date()) : undefined;
        return (
          <FieldFrame
            id={id}
            descriptionId={descriptionId}
            label={label}
            description={description}
            error={fieldState.error}
            inline={inline}
          >
            <DatePicker
              id={id}
              ref={field.ref}
              onBlur={field.onBlur}
              className={inline ? ROW_CONTROL : undefined}
              date={parsed && isValid(parsed) ? parsed : undefined}
              onDateChange={(date) => field.onChange(date ? format(date, DATE_VALUE) : '')}
              placeholder={t.projects.raid.form.pickDate}
              locale={dateFnsLocale}
              aria-invalid={fieldState.invalid}
              aria-describedby={descriptionId}
            />
          </FieldFrame>
        );
      }}
    />
  );
}

export function TextAreaField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  placeholder,
  rows = 3,
}: Readonly<BaseFieldProps<T> & { placeholder?: string; rows?: number }>) {
  const { id, descriptionId } = useFieldIds(description);
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldFrame id={id} descriptionId={descriptionId} label={label} description={description} error={fieldState.error}>
          <Textarea
            {...field}
            id={id}
            value={(field.value as string | null | undefined) ?? ''}
            placeholder={placeholder}
            rows={rows}
            aria-invalid={fieldState.invalid}
            aria-describedby={descriptionId}
          />
        </FieldFrame>
      )}
    />
  );
}

/** A number input whose empty value is null. */
export function NumberField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  min = 0,
  step,
  inline,
}: Readonly<BaseFieldProps<T> & { min?: number; step?: number | 'any' }>) {
  const { id, descriptionId } = useFieldIds(description);
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldFrame
          id={id}
          descriptionId={descriptionId}
          label={label}
          description={description}
          error={fieldState.error}
          inline={inline}
        >
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            min={min}
            step={step}
            name={field.name}
            ref={field.ref}
            onBlur={field.onBlur}
            className={inline ? ROW_CONTROL : undefined}
            value={(field.value as number | null | undefined) ?? ''}
            onChange={(event) => field.onChange(event.target.value === '' ? null : Number(event.target.value))}
            aria-invalid={fieldState.invalid}
            aria-describedby={descriptionId}
          />
        </FieldFrame>
      )}
    />
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/** A select whose "none" choice stores null. */
export function SelectField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  options,
  noneLabel,
  placeholder,
  inline,
}: Readonly<
  BaseFieldProps<T> & {
    options: SelectOption[];
    /** Offers a first choice that stores null. */
    noneLabel?: string;
    placeholder?: string;
  }
>) {
  const { id, descriptionId } = useFieldIds(description);
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldFrame
          id={id}
          descriptionId={descriptionId}
          label={label}
          description={description}
          error={fieldState.error}
          inline={inline}
        >
          <Select
            name={field.name}
            value={(field.value as string | null | undefined) ?? (noneLabel ? NONE : '')}
            onValueChange={(value) => field.onChange(value === NONE ? null : value)}
          >
            <SelectTrigger
              id={id}
              ref={field.ref}
              onBlur={field.onBlur}
              className={inline ? ROW_CONTROL : undefined}
              aria-invalid={fieldState.invalid}
              aria-describedby={descriptionId}
            >
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              {noneLabel ? <SelectItem value={NONE}>{noneLabel}</SelectItem> : null}
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldFrame>
      )}
    />
  );
}

export function CheckboxField<T extends FieldValues>({
  control,
  name,
  label,
}: Readonly<Omit<BaseFieldProps<T>, 'description' | 'inline'>>) {
  const id = useId();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <Field orientation="horizontal">
          <Checkbox
            id={id}
            ref={field.ref}
            checked={field.value === true}
            onCheckedChange={(checked) => field.onChange(checked === true)}
          />
          <FieldLabel htmlFor={id} className="font-normal">
            {label}
          </FieldLabel>
        </Field>
      )}
    />
  );
}
