"use client";

import * as React from "react";
import { cn } from "../lib/utils";
import { Input } from "./input";
import { Label } from "./label";
import { Textarea } from "./textarea";
import { Checkbox } from "./checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

// Form Field Wrapper - displays label and error message
interface FormFieldWrapperProps {
  label?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
  htmlFor?: string;
}

export function FormFieldWrapper({
  label,
  error,
  required,
  className,
  children,
  htmlFor,
}: FormFieldWrapperProps) {
  return (
    <div className={cn("space-y-2", className)}>
      {label && (
        <Label htmlFor={htmlFor}>
          {label}
          {required && <span className="text-destructive ml-1">*</span>}
        </Label>
      )}
      {children}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// Input with Error
interface InputWithErrorProps extends React.ComponentPropsWithoutRef<typeof Input> {
  label?: string;
  error?: string;
  required?: boolean;
}

export const InputWithError = React.forwardRef<
  React.ElementRef<typeof Input>,
  InputWithErrorProps
>(({ label, error, required, className, id, ...props }, ref) => {
  const inputId = id || props.name;
  
  return (
    <FormFieldWrapper
      label={label}
      error={error}
      required={required}
      htmlFor={inputId}
    >
      <Input
        ref={ref}
        id={inputId}
        className={cn(
          error && "border-destructive focus-visible:border-destructive",
          className
        )}
        aria-invalid={!!error}
        aria-describedby={error ? `${inputId}-error` : undefined}
        {...props}
      />
    </FormFieldWrapper>
  );
});
InputWithError.displayName = "InputWithError";

// Textarea with Error
interface TextareaWithErrorProps extends React.ComponentPropsWithoutRef<typeof Textarea> {
  label?: string;
  error?: string;
  required?: boolean;
}

export const TextareaWithError = React.forwardRef<
  React.ElementRef<typeof Textarea>,
  TextareaWithErrorProps
>(({ label, error, required, className, id, ...props }, ref) => {
  const textareaId = id || props.name;
  
  return (
    <FormFieldWrapper
      label={label}
      error={error}
      required={required}
      htmlFor={textareaId}
    >
      <Textarea
        ref={ref}
        id={textareaId}
        className={cn(
          error && "border-destructive focus-visible:border-destructive",
          className
        )}
        aria-invalid={!!error}
        aria-describedby={error ? `${textareaId}-error` : undefined}
        {...props}
      />
    </FormFieldWrapper>
  );
});
TextareaWithError.displayName = "TextareaWithError";

// Select with Error
interface SelectWithErrorProps {
  label?: string;
  error?: string;
  required?: boolean;
  placeholder?: string;
  options: Array<{ value: string; label: string }>;
  value?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  id?: string;
  className?: string;
}

export function SelectWithError({
  label,
  error,
  required,
  placeholder,
  options,
  value,
  onValueChange,
  name,
  id,
  className,
}: SelectWithErrorProps) {
  const selectId = id || name;
  
  return (
    <FormFieldWrapper
      label={label}
      error={error}
      required={required}
      htmlFor={selectId}
    >
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger
          id={selectId}
          className={cn(
            error && "border-destructive focus:border-destructive",
            className
          )}
          aria-invalid={!!error}
          aria-describedby={error ? `${selectId}-error` : undefined}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormFieldWrapper>
  );
}

// Checkbox with Error
interface CheckboxWithErrorProps extends React.ComponentPropsWithoutRef<typeof Checkbox> {
  label?: string;
  error?: string;
}

export const CheckboxWithError = React.forwardRef<
  React.ElementRef<typeof Checkbox>,
  CheckboxWithErrorProps
>(({ label, error, className, id, ...props }, ref) => {
  const checkboxId = id || props.name;
  
  return (
    <div className="space-y-2">
      <div className="flex items-center space-x-2">
        <Checkbox
          ref={ref}
          id={checkboxId}
          className={cn(
            error && "border-destructive data-[state=checked]:bg-destructive",
            className
          )}
          aria-invalid={!!error}
          aria-describedby={error ? `${checkboxId}-error` : undefined}
          {...props}
        />
        {label && (
          <Label 
            htmlFor={checkboxId}
            className="text-sm font-normal leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {label}
          </Label>
        )}
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
});
CheckboxWithError.displayName = "CheckboxWithError";