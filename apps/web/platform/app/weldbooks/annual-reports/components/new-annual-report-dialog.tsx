/**
 * "New annual report": the financial year (named for the calendar year it
 * ends in; the KvK taxonomy covers 2025 and 2026) and the company size, with
 * a line on what each size publishes.
 */

import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel } from '@weldsuite/ui/components/form';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import {
  ANNUAL_REPORT_YEARS,
  defaultAnnualReportYear,
  type AnnualReportSizeClass,
} from '@/lib/weldbooks/annual-report-model';

const schema = z.object({
  fiscalYear: z.string().regex(/^\d{4}$/),
  sizeClass: z.enum(['micro', 'small']),
});

type Values = z.infer<typeof schema>;

export function NewAnnualReportDialog({
  open,
  onOpenChange,
  pending,
  existingYears,
  onSubmit,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  existingYears: readonly number[];
  onSubmit: (values: { fiscalYear: number; sizeClass: AnnualReportSizeClass }) => void;
}>) {
  const { t } = useI18n();
  const tc = t.weldbooksNl.annualReports.create;
  const defaults = useMemo<Values>(
    () => ({ fiscalYear: String(defaultAnnualReportYear(new Date(), existingYears)), sizeClass: 'small' }),
    [existingYears],
  );
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults });

  // Every opening starts from last year and the small size.
  useEffect(() => {
    if (open) form.reset(defaults);
  }, [open, defaults, form]);

  const options: ReadonlyArray<{ value: AnnualReportSizeClass; title: string; description: string }> = [
    { value: 'micro', title: tc.microTitle, description: tc.microDescription },
    { value: 'small', title: tc.smallTitle, description: tc.smallDescription },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tc.title}</DialogTitle>
          <DialogDescription>{tc.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((values) =>
              onSubmit({ fiscalYear: Number(values.fiscalYear), sizeClass: values.sizeClass }),
            )}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="fiscalYear"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tc.fiscalYear}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ANNUAL_REPORT_YEARS.map((year) => (
                        <SelectItem key={year} value={String(year)}>
                          {year}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="sizeClass"
              render={({ field }) => (
                <FormItem role="group" aria-labelledby="new-report-size">
                  <span id="new-report-size" className="text-sm font-medium leading-none">
                    {tc.sizeClass}
                  </span>
                  <RadioGroup value={field.value} onValueChange={field.onChange} className="gap-2">
                    {options.map((option) => (
                      <label
                        key={option.value}
                        htmlFor={`size-${option.value}`}
                        className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary"
                      >
                        <RadioGroupItem id={`size-${option.value}`} value={option.value} className="mt-0.5" />
                        <span className="space-y-0.5">
                          <span className="block text-sm font-medium">{option.title}</span>
                          <span className="block text-sm text-muted-foreground">{option.description}</span>
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.accounting.vat.cancel}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? tc.creating : tc.submit}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
