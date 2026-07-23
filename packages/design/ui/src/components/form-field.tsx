"use client";

import * as React from "react";
import { cn } from "../lib/utils";
import { Label } from "./label";

interface FormFieldProps {
  label?: string;
  error?: string;
  required?: boolean;
  /**
   * Optional tooltip or popover component to display next to the label
   * Pass InfoTooltip or InfoPopover component as a ReactNode
   */
  info?: React.ReactNode;
  /**
   * Optional help text to display below the field (above error)
   */
  helpText?: string | React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function FormField({
  label,
  error,
  required,
  info,
  helpText,
  className,
  children,
}: FormFieldProps) {
  return (
    <div className={className}>
      {label && (
        <div className="mb-2 flex items-center gap-1.5">
          <Label>
            {label}
            {required && <span className="text-destructive ml-1">*</span>}
          </Label>
          {info}
        </div>
      )}
      {children}
      {helpText && (
        <p className="text-sm text-muted-foreground mt-1.5">{helpText}</p>
      )}
      {error && (
        <p className="text-sm text-destructive mt-1.5">{error}</p>
      )}
    </div>
  );
}

interface FormInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  label?: string;
  required?: boolean;
  /**
   * Optional tooltip or popover component to display next to the label
   */
  info?: React.ReactNode;
  /**
   * Optional help text to display below the field (above error)
   */
  helpText?: string | React.ReactNode;
}

export const FormInput = React.forwardRef<HTMLInputElement, FormInputProps>(
  ({ error, label, required, info, helpText, className, ...props }, ref) => {
    return (
      <FormField label={label} error={error} required={required} info={info} helpText={helpText}>
        <input
          ref={ref}
          className={cn(
            "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            error && "border-destructive focus-visible:ring-destructive",
            className
          )}
          aria-invalid={!!error}
          aria-describedby={error ? `${props.id}-error` : undefined}
          {...props}
        />
      </FormField>
    );
  }
);
FormInput.displayName = "FormInput";

interface FormTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string;
  label?: string;
  required?: boolean;
  /**
   * Optional tooltip or popover component to display next to the label
   */
  info?: React.ReactNode;
  /**
   * Optional help text to display below the field (above error)
   */
  helpText?: string | React.ReactNode;
}

export const FormTextarea = React.forwardRef<HTMLTextAreaElement, FormTextareaProps>(
  ({ error, label, required, info, helpText, className, ...props }, ref) => {
    return (
      <FormField label={label} error={error} required={required} info={info} helpText={helpText}>
        <textarea
          ref={ref}
          className={cn(
            "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            error && "border-destructive focus-visible:ring-destructive",
            className
          )}
          aria-invalid={!!error}
          aria-describedby={error ? `${props.id}-error` : undefined}
          {...props}
        />
      </FormField>
    );
  }
);
FormTextarea.displayName = "FormTextarea";

interface FormSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: string;
  label?: string;
  required?: boolean;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  /**
   * Optional tooltip or popover component to display next to the label
   */
  info?: React.ReactNode;
  /**
   * Optional help text to display below the field (above error)
   */
  helpText?: string | React.ReactNode;
}

export const FormSelect = React.forwardRef<HTMLSelectElement, FormSelectProps>(
  ({ error, label, required, options, placeholder, info, helpText, className, ...props }, ref) => {
    return (
      <FormField label={label} error={error} required={required} info={info} helpText={helpText}>
        <select
          ref={ref}
          className={cn(
            "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            error && "border-destructive focus-visible:ring-destructive",
            className
          )}
          aria-invalid={!!error}
          aria-describedby={error ? `${props.id}-error` : undefined}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FormField>
    );
  }
);
FormSelect.displayName = "FormSelect";

interface FormCheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  label?: string;
}

export const FormCheckbox = React.forwardRef<HTMLInputElement, FormCheckboxProps>(
  ({ error, label, className, ...props }, ref) => {
    return (
      <div className="space-y-3">
        <div className="flex items-center space-x-2">
          <input
            ref={ref}
            type="checkbox"
            className={cn(
              "h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary",
              error && "border-destructive",
              className
            )}
            aria-invalid={!!error}
            aria-describedby={error ? `${props.id}-error` : undefined}
            {...props}
          />
          {label && (
            <Label htmlFor={props.id} className="text-sm font-normal cursor-pointer">
              {label}
            </Label>
          )}
        </div>
        {error && (
          <p className="text-sm text-destructive mt-1">{error}</p>
        )}
      </div>
    );
  }
);
FormCheckbox.displayName = "FormCheckbox";