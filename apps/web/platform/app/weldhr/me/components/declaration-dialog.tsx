/** My HR → new declaration: date, category, amount, what it was for, and an optional receipt. */

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import { HR_DECLARATION_CURRENCIES, hrDeclarationCategorySchema } from '@weldsuite/app-api-client/schemas/weldhr';
import { useMyHrCreateDeclaration } from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, errorMessage, todayIso } from '../../components/shared';
import { RECEIPT_ACCEPT, parseAmount, receiptProblem } from '../../declarations/components/receipt-field';

function buildSchema(t: (path: string) => string) {
  return z.object({
    expenseDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, t('weldhr.me.declarations.form.errors.date'))
      .refine((value) => value <= todayIso(), t('weldhr.me.declarations.form.errors.futureDate')),
    category: hrDeclarationCategorySchema,
    amount: z.string().refine((value) => parseAmount(value) !== null, t('weldhr.me.declarations.form.errors.amount')),
    currency: z.enum(HR_DECLARATION_CURRENCIES),
    description: z
      .string()
      .trim()
      .min(1, t('weldhr.me.declarations.form.errors.description'))
      .max(2000, t('weldhr.me.declarations.form.errors.descriptionLength')),
  });
}

type FormValues = z.infer<ReturnType<typeof buildSchema>>;

export function MyDeclarationDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const t = useTranslations();
  const createDeclaration = useMyHrCreateDeclaration();
  const [receipt, setReceipt] = useState<File | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const schema = useMemo(() => buildSchema(t), [t]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { expenseDate: todayIso(), category: 'travel', amount: '', currency: 'EUR', description: '' },
  });

  const isSubmitting = createDeclaration.isPending;

  function pickReceipt(file: File | null) {
    const problem = file ? receiptProblem(file) : null;
    setReceiptError(
      problem ? t(`weldhr.me.declarations.form.errors.${problem === 'size' ? 'receiptTooLarge' : 'receiptType'}`) : null,
    );
    setReceipt(problem ? null : file);
  }

  async function onSubmit(values: FormValues) {
    const amount = parseAmount(values.amount);
    if (amount === null || receiptError) return;
    setFailure(null);
    try {
      const result = await createDeclaration.mutateAsync({
        expenseDate: values.expenseDate,
        category: values.category,
        amount,
        currency: values.currency,
        description: values.description,
        receipt,
      });
      if (result.receiptFailed) toast.warning(t('weldhr.me.declarations.form.receiptUploadFailed'));
      else toast.success(t('weldhr.me.declarations.form.submittedToast'));
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.me.declarations.form.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !isSubmitting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('weldhr.me.declarations.form.title')}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="expenseDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.me.declarations.form.date')}</FormLabel>
                    <FormControl>
                      <Input type="date" max={todayIso()} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.me.declarations.form.category')}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {hrDeclarationCategorySchema.options.map((option) => (
                          <SelectItem key={option} value={option}>
                            {t(`weldhr.declarations.category.${option}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.me.declarations.form.amount')}</FormLabel>
                    <FormControl>
                      <Input inputMode="decimal" placeholder="0.00" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.me.declarations.form.currency')}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {HR_DECLARATION_CURRENCIES.map((code) => (
                          <SelectItem key={code} value={code}>
                            {code}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('weldhr.me.declarations.form.description')}</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder={t('weldhr.me.declarations.form.descriptionPlaceholder')} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* The file lives outside react-hook-form: it is uploaded after the declaration exists. */}
            <div className="grid gap-2">
              <Label htmlFor="my-hr-declaration-receipt">{t('weldhr.me.declarations.form.receipt')}</Label>
              <Input
                id="my-hr-declaration-receipt"
                type="file"
                accept={RECEIPT_ACCEPT}
                onChange={(e) => pickReceipt(e.target.files?.[0] ?? null)}
              />
              <p className={receiptError ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
                {receiptError ?? t('weldhr.me.declarations.form.receiptHint')}
              </p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={isSubmitting || Boolean(receiptError)}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isSubmitting ? t('weldhr.me.declarations.form.submitting') : t('weldhr.me.declarations.form.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
