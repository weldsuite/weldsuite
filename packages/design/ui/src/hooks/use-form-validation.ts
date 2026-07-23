import { useState, useCallback } from 'react';
import { z, ZodSchema, ZodError } from 'zod';

type ValidationErrors = Record<string, string>;

interface UseFormValidationOptions<T> {
  schema: ZodSchema<T>;
  onSubmit?: (data: T) => void | Promise<void>;
  initialValues?: Partial<T>;
}

export function useFormValidation<T>({
  schema,
  onSubmit,
  initialValues = {},
}: UseFormValidationOptions<T>) {
  const [values, setValues] = useState<Partial<T>>(initialValues);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const validateField = useCallback(
    (name: string, value: any) => {
      try {
        // Check if schema has shape property (ZodObject)
        if ('shape' in schema && schema.shape) {
          const fieldSchema = (schema.shape as any)[name];
          if (fieldSchema) {
            fieldSchema.parse(value);
            setErrors((prev) => {
              const newErrors = { ...prev };
              delete newErrors[name];
              return newErrors;
            });
            return true;
          }
        }
      } catch (error) {
        if (error instanceof ZodError) {
          setErrors((prev) => ({
            ...prev,
            [name]: error.errors[0]?.message || 'Invalid value',
          }));
          return false;
        }
      }
      return true;
    },
    [schema]
  );

  const handleChange = useCallback(
    (name: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const value = e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value;
      setValues((prev) => ({ ...prev, [name]: value }));
      
      if (touched[name]) {
        validateField(name, value);
      }
    },
    [touched, validateField]
  );

  const handleBlur = useCallback(
    (name: string) => () => {
      setTouched((prev) => ({ ...prev, [name]: true }));
      validateField(name, values[name as keyof typeof values]);
    },
    [values, validateField]
  );

  const validateForm = useCallback((): boolean => {
    try {
      schema.parse(values);
      setErrors({});
      return true;
    } catch (error) {
      if (error instanceof ZodError) {
        const newErrors: ValidationErrors = {};
        error.errors.forEach((err) => {
          const path = err.path.join('.');
          if (!newErrors[path]) {
            newErrors[path] = err.message;
          }
        });
        setErrors(newErrors);
        
        // Mark all fields as touched
        const touchedFields: Record<string, boolean> = {};
        Object.keys(values).forEach((key) => {
          touchedFields[key] = true;
        });
        setTouched(touchedFields);
        
        return false;
      }
      return false;
    }
  }, [schema, values]);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      if (e) {
        e.preventDefault();
      }

      if (!validateForm()) {
        return;
      }

      if (onSubmit) {
        setIsSubmitting(true);
        try {
          await onSubmit(values as T);
        } catch (error) {
          console.error('Form submission error:', error);
        } finally {
          setIsSubmitting(false);
        }
      }
    },
    [validateForm, onSubmit, values]
  );

  const reset = useCallback(() => {
    setValues(initialValues);
    setErrors({});
    setTouched({});
    setIsSubmitting(false);
  }, [initialValues]);

  const setFieldValue = useCallback((name: string, value: any) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    if (touched[name]) {
      validateField(name, value);
    }
  }, [touched, validateField]);

  const setFieldError = useCallback((name: string, error: string) => {
    setErrors((prev) => ({ ...prev, [name]: error }));
  }, []);

  return {
    values,
    errors,
    touched,
    isSubmitting,
    handleChange,
    handleBlur,
    handleSubmit,
    reset,
    setFieldValue,
    setFieldError,
    validateForm,
    validateField,
  };
}

// Example schemas for common form validations
export const commonSchemas = {
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number'),
  url: z.string().url('Invalid URL'),
  required: z.string().min(1, 'This field is required'),
  positiveNumber: z.number().positive('Must be a positive number'),
  date: z.string().datetime('Invalid date'),
};