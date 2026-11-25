/**
 * The details the KvK requires next to the figures: legal form, KvK number,
 * registered office and place, postal code, email, date of preparation,
 * profit appropriation, average number of employees (required for small
 * companies), plus adoption and internal notes. What the server's readiness
 * check found missing shows under the field it belongs to.
 */

import type { ReactNode } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useI18n } from '@/lib/i18n/provider';
import type { AnnualReport } from '@/lib/weldbooks/annual-report-model';
import type { AnnualReportFormValues } from '../annual-report-form';

type FieldName =
  | 'disclosures.kvkNumber'
  | 'disclosures.registeredOffice'
  | 'disclosures.city'
  | 'disclosures.postalCode'
  | 'disclosures.email'
  | 'disclosures.preparedOn';

export function DisclosuresFields({
  form,
  report,
  editable,
  onSubmit,
  children,
}: Readonly<{
  form: UseFormReturn<AnnualReportFormValues>;
  report: AnnualReport;
  editable: boolean;
  onSubmit: (values: AnnualReportFormValues) => void;
  /** The balance sheet, rendered inside the same form so Save covers both. */
  children: ReactNode;
}>) {
  const { t } = useI18n();
  const td = t.weldbooksNl.annualReports.disclosures;
  const ta = t.weldbooksNl.annualReports;
  const issues = new Map(report.issues.map((issue) => [issue.field, issue.message]));
  const small = form.watch('sizeClass') === 'small';
  const adopted = form.watch('adopted');

  const text = (
    name: FieldName,
    issue: string,
    label: string,
    props: Record<string, string | number | boolean> = {},
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl invalid={issues.has(issue)}>
            <Input {...field} disabled={!editable} {...props} />
          </FormControl>
          <FormMessage>{issues.get(issue)}</FormMessage>
        </FormItem>
      )}
    />
  );

  return (
    <Form {...form}>
      <form id="annual-report-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {children}

        <section aria-labelledby="disclosures-title" className="space-y-4">
          <h2 id="disclosures-title" className="text-base font-semibold">
            {td.title}
          </h2>

          <FormField
            control={form.control}
            name="sizeClass"
            render={({ field }) => (
              <FormItem>
                <span id="size-class-label" className="text-sm font-medium leading-none">
                  {t.weldbooksNl.annualReports.detail.sizeClass}
                </span>
                <FormControl>
                  <RadioGroup aria-labelledby="size-class-label" value={field.value} onValueChange={field.onChange} disabled={!editable} className="flex gap-6">
                    {(['micro', 'small'] as const).map((value) => (
                      <label key={value} htmlFor={`edit-size-${value}`} className="flex items-center gap-2 text-sm">
                        <RadioGroupItem id={`edit-size-${value}`} value={value} />
                        {ta.sizeClasses[value]}
                      </label>
                    ))}
                  </RadioGroup>
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="disclosures.legalForm"
            render={({ field }) => (
              <FormItem>
                <span id="legal-form-label" className="text-sm font-medium leading-none">
                  {td.legalForm}
                </span>
                <FormControl invalid={issues.has('legalForm')}>
                  <RadioGroup aria-labelledby="legal-form-label" value={field.value} onValueChange={field.onChange} disabled={!editable} className="flex gap-6">
                    {(['bv', 'nv'] as const).map((value) => (
                      <label key={value} htmlFor={`legal-form-${value}`} className="flex items-center gap-2 text-sm">
                        <RadioGroupItem id={`legal-form-${value}`} value={value} />
                        {td.legalForms[value]}
                      </label>
                    ))}
                  </RadioGroup>
                </FormControl>
                <FormMessage>{issues.get('legalForm')}</FormMessage>
              </FormItem>
            )}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            {text('disclosures.kvkNumber', 'kvkNumber', td.kvkNumber, { inputMode: 'numeric', maxLength: 8, autoComplete: 'off' })}
            {text('disclosures.registeredOffice', 'registeredOffice', td.registeredOffice)}
            {text('disclosures.city', 'city', td.city, { autoComplete: 'address-level2' })}
            {text('disclosures.postalCode', 'postalCode', td.postalCode, { autoComplete: 'postal-code', maxLength: 10 })}
            {text('disclosures.email', 'email', td.email, { type: 'email', autoComplete: 'email', spellCheck: false })}
            {text('disclosures.preparedOn', 'preparedOn', td.preparedOn, { type: 'date' })}
          </div>

          <FormField
            control={form.control}
            name="disclosures.appropriation"
            render={({ field }) => (
              <FormItem>
                <span id="appropriation-label" className="text-sm font-medium leading-none">
                  {td.appropriation}
                </span>
                <FormControl invalid={issues.has('appropriation')}>
                  <RadioGroup aria-labelledby="appropriation-label" value={field.value} onValueChange={field.onChange} disabled={!editable} className="flex flex-wrap gap-x-6 gap-y-2">
                    {(['before', 'after'] as const).map((value) => (
                      <label key={value} htmlFor={`appropriation-${value}`} className="flex items-center gap-2 text-sm">
                        <RadioGroupItem id={`appropriation-${value}`} value={value} />
                        {td.appropriations[value]}
                      </label>
                    ))}
                  </RadioGroup>
                </FormControl>
                <FormMessage>{issues.get('appropriation')}</FormMessage>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="disclosures.averageEmployees"
            render={({ field }) => (
              <FormItem className="sm:max-w-xs">
                <FormLabel>{small ? td.averageEmployeesRequired : td.averageEmployees}</FormLabel>
                <FormControl invalid={issues.has('averageEmployees')}>
                  <NumberInput
                    min={0}
                    step={1}
                    disabled={!editable}
                    required={small}
                    value={field.value}
                    onValueChange={field.onChange}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                  />
                </FormControl>
                <FormMessage>{issues.get('averageEmployees')}</FormMessage>
              </FormItem>
            )}
          />
        </section>

        <section aria-labelledby="adoption-title" className="space-y-4">
          <h2 id="adoption-title" className="text-base font-semibold">
            {td.adoptionTitle}
          </h2>
          <FormField
            control={form.control}
            name="adopted"
            render={({ field }) => (
              <FormItem className="flex items-center gap-2 space-y-0">
                <FormControl>
                  <Checkbox checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} disabled={!editable} />
                </FormControl>
                <FormLabel className="font-normal">{td.adopted}</FormLabel>
              </FormItem>
            )}
          />
          {adopted ? (
            <FormField
              control={form.control}
              name="adoptionDate"
              render={({ field }) => (
                <FormItem className="sm:max-w-xs">
                  <FormLabel>{td.adoptionDate}</FormLabel>
                  <FormControl invalid={issues.has('adoptionDate')}>
                    <Input type="date" {...field} disabled={!editable} />
                  </FormControl>
                  <FormMessage>{issues.get('adoptionDate')}</FormMessage>
                </FormItem>
              )}
            />
          ) : null}
          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{td.notes}</FormLabel>
                <FormControl>
                  <Textarea rows={3} {...field} disabled={!editable} />
                </FormControl>
              </FormItem>
            )}
          />
        </section>
      </form>
    </Form>
  );
}
