/**
 * Field rules the employee create and edit forms share, with messages people
 * can read ("First name is required") instead of Zod's defaults ("String must
 * contain at least 1 character(s)").
 */

import { z } from 'zod';

type Translate = (path: string, params?: Record<string, unknown>) => string;

/** Digits with the usual separators and an optional leading +; at least six digits. */
export function isPhoneNumber(value: string): boolean {
  return /^\+?[\d\s().-]+$/.test(value) && (value.match(/\d/g)?.length ?? 0) >= 6;
}

export function employeeFieldRules(t: Translate) {
  return {
    firstName: z.string().trim().min(1, t('weldhr.employees.validation.firstNameRequired')),
    lastName: z.string().trim().min(1, t('weldhr.employees.validation.lastNameRequired')),
    email: z
      .string()
      .trim()
      .min(1, t('weldhr.employees.validation.emailRequired'))
      .email(t('weldhr.employees.validation.emailInvalid')),
    phone: z
      .string()
      .trim()
      .refine((value) => value === '' || isPhoneNumber(value), t('weldhr.employees.validation.phoneInvalid'))
      .optional(),
  };
}
