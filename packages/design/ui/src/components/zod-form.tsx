"use client";

import * as React from "react";
import { z, ZodSchema } from "zod";
import { useFormValidation } from "../hooks/use-form-validation";
import { FormInput, FormTextarea, FormSelect, FormCheckbox } from "./form-field";
import { Button } from "./button";
import { cn } from "../lib/utils";

interface ZodFormProps<T extends ZodSchema> {
  schema: T;
  onSubmit: (data: z.infer<T>) => void | Promise<void>;
  initialValues?: Partial<z.infer<T>>;
  className?: string;
  children?: React.ReactNode;
  submitLabel?: string;
  resetLabel?: string;
  showReset?: boolean;
}

export function ZodForm<T extends ZodSchema>({
  schema,
  onSubmit,
  initialValues,
  className,
  children,
  submitLabel = "Submit",
  resetLabel = "Reset",
  showReset = false,
}: ZodFormProps<T>) {
  const {
    values,
    errors,
    touched,
    isSubmitting,
    handleChange,
    handleBlur,
    handleSubmit,
    reset,
    setFieldValue,
  } = useFormValidation({
    schema,
    onSubmit,
    initialValues,
  });

  const formContext = {
    values,
    errors,
    touched,
    handleChange,
    handleBlur,
    setFieldValue,
  };

  return (
    <FormProvider value={formContext}>
      <form onSubmit={handleSubmit} className={cn("space-y-4", className)}>
        {children}
        <div className="flex gap-4">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Submitting..." : submitLabel}
          </Button>
          {showReset && (
            <Button type="button" variant="outline" onClick={reset}>
              {resetLabel}
            </Button>
          )}
        </div>
      </form>
    </FormProvider>
  );
}

// Form Context
interface FormContextValue {
  values: Record<string, any>;
  errors: Record<string, string>;
  touched: Record<string, boolean>;
  handleChange: (name: string) => (e: React.ChangeEvent<any>) => void;
  handleBlur: (name: string) => () => void;
  setFieldValue: (name: string, value: any) => void;
}

const FormContext = React.createContext<FormContextValue | undefined>(undefined);

function FormProvider({
  value,
  children,
}: {
  value: FormContextValue;
  children: React.ReactNode;
}) {
  return <FormContext.Provider value={value}>{children}</FormContext.Provider>;
}

export function useZodForm() {
  const context = React.useContext(FormContext);
  if (!context) {
    throw new Error("useZodForm must be used within a ZodForm");
  }
  return context;
}

// Form Field Components with Zod integration
interface ZodFieldProps {
  name: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  type?: string;
}

export function ZodInput({
  name,
  label,
  placeholder,
  required,
  type = "text",
  ...props
}: ZodFieldProps & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'name' | 'type'>) {
  const { values, errors, handleChange, handleBlur } = useZodForm();

  return (
    <FormInput
      id={name}
      name={name}
      type={type}
      value={values[name] || ""}
      onChange={handleChange(name)}
      onBlur={handleBlur(name)}
      error={errors[name]}
      label={label}
      placeholder={placeholder}
      required={required}
      {...props}
    />
  );
}

export function ZodTextarea({
  name,
  label,
  placeholder,
  required,
  ...props
}: ZodFieldProps & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'name'>) {
  const { values, errors, handleChange, handleBlur } = useZodForm();

  return (
    <FormTextarea
      id={name}
      name={name}
      value={values[name] || ""}
      onChange={handleChange(name)}
      onBlur={handleBlur(name)}
      error={errors[name]}
      label={label}
      placeholder={placeholder}
      required={required}
      {...props}
    />
  );
}

interface ZodSelectProps extends ZodFieldProps {
  options: Array<{ value: string; label: string }>;
}

export function ZodSelect({
  name,
  label,
  placeholder,
  required,
  options,
  ...props
}: ZodSelectProps & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'name'>) {
  const { values, errors, handleChange, handleBlur } = useZodForm();

  return (
    <FormSelect
      id={name}
      name={name}
      value={values[name] || ""}
      onChange={handleChange(name)}
      onBlur={handleBlur(name)}
      error={errors[name]}
      label={label}
      placeholder={placeholder}
      required={required}
      options={options}
      {...props}
    />
  );
}

export function ZodCheckbox({
  name,
  label,
  ...props
}: Omit<ZodFieldProps, 'placeholder' | 'required'> & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'name' | 'type'>) {
  const { values, errors, handleChange, handleBlur } = useZodForm();

  return (
    <FormCheckbox
      id={name}
      name={name}
      checked={values[name] || false}
      onChange={handleChange(name)}
      onBlur={handleBlur(name)}
      error={errors[name]}
      label={label}
      {...props}
    />
  );
}