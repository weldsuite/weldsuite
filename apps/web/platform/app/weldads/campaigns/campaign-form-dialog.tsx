'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import {
  useCreateWeldAdsCampaign,
  useUpdateWeldAdsCampaign,
  type AdAccount,
  type AdCampaignObjective,
  type AdCampaignRow,
} from '@/hooks/queries/use-weldads-queries';

const OBJECTIVES: AdCampaignObjective[] = [
  'OUTCOME_TRAFFIC',
  'OUTCOME_SALES',
  'OUTCOME_LEADS',
  'OUTCOME_AWARENESS',
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_APP_PROMOTION',
];

function majorToMinor(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed * 100);
}

function minorToMajor(value: number | null | undefined): string {
  if (value == null) return '';
  return (value / 100).toFixed(2);
}

interface CampaignFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AdAccount[];
  campaign?: AdCampaignRow | null;
}

export function CampaignFormDialog({
  open,
  onOpenChange,
  accounts,
  campaign,
}: CampaignFormDialogProps) {
  const t = getTranslations('weldads').module;
  const isEdit = !!campaign;
  const selectedAccounts = accounts.filter((account) => account.isSelected);

  const schema = z
    .object({
      adAccountId: z.string().min(1),
      name: z.string().trim().min(1).max(255),
      objective: z.enum([
        'OUTCOME_TRAFFIC',
        'OUTCOME_SALES',
        'OUTCOME_LEADS',
        'OUTCOME_AWARENESS',
        'OUTCOME_ENGAGEMENT',
        'OUTCOME_APP_PROMOTION',
      ]),
      dailyBudget: z.string().optional(),
      lifetimeBudget: z.string().optional(),
      startPaused: z.boolean(),
    })
    .superRefine((values, ctx) => {
      if (!isEdit && !majorToMinor(values.dailyBudget) && !majorToMinor(values.lifetimeBudget)) {
        ctx.addIssue({ code: 'custom', message: t.budgetRequired, path: ['dailyBudget'] });
      }
    });

  type FormValues = z.infer<typeof schema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      adAccountId: campaign?.adAccountId ?? selectedAccounts[0]?.id ?? '',
      name: campaign?.name ?? '',
      objective: (campaign?.objective as AdCampaignObjective | undefined) ?? 'OUTCOME_TRAFFIC',
      dailyBudget: minorToMajor(campaign?.dailyBudget),
      lifetimeBudget: minorToMajor(campaign?.lifetimeBudget),
      startPaused: true,
    },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      adAccountId: campaign?.adAccountId ?? selectedAccounts[0]?.id ?? '',
      name: campaign?.name ?? '',
      objective: (campaign?.objective as AdCampaignObjective | undefined) ?? 'OUTCOME_TRAFFIC',
      dailyBudget: minorToMajor(campaign?.dailyBudget),
      lifetimeBudget: minorToMajor(campaign?.lifetimeBudget),
      startPaused: true,
    });
  }, [campaign, form, open, selectedAccounts]);

  const createMutation = useCreateWeldAdsCampaign();
  const updateMutation = useUpdateWeldAdsCampaign();
  const pending = createMutation.isPending || updateMutation.isPending;

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) form.reset();
    onOpenChange(nextOpen);
  };

  const onSubmit = async (values: FormValues) => {
    const dailyBudget = majorToMinor(values.dailyBudget);
    const lifetimeBudget = majorToMinor(values.lifetimeBudget);

    try {
      if (isEdit && campaign) {
        await updateMutation.mutateAsync({
          id: campaign.id,
          name: values.name,
          objective: values.objective,
          ...(dailyBudget != null ? { dailyBudget } : {}),
          ...(lifetimeBudget != null ? { lifetimeBudget } : {}),
        });
        toast.success(t.updateSuccess);
      } else {
        await createMutation.mutateAsync({
          adAccountId: values.adAccountId,
          name: values.name,
          objective: values.objective,
          status: values.startPaused ? 'PAUSED' : 'ACTIVE',
          ...(dailyBudget != null ? { dailyBudget } : {}),
          ...(lifetimeBudget != null ? { lifetimeBudget } : {}),
        });
        toast.success(t.createSuccess);
      }
      handleClose(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.saveError);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.editCampaign : t.createCampaign}</DialogTitle>
          <DialogDescription>{t.budgetHint}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {!isEdit && (
              <FormField
                control={form.control}
                name="adAccountId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.account}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t.account} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {selectedAccounts.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {account.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t.campaign}</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="objective"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t.objective}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {OBJECTIVES.map((objective) => (
                        <SelectItem key={objective} value={objective}>
                          {t.objectives[objective]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="dailyBudget"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.dailyBudget}</FormLabel>
                    <FormControl>
                      <Input {...field} inputMode="decimal" placeholder="10.00" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lifetimeBudget"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.lifetimeBudget}</FormLabel>
                    <FormControl>
                      <Input {...field} inputMode="decimal" placeholder="100.00" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {!isEdit && (
              <FormField
                control={form.control}
                name="startPaused"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-3 space-y-0">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <FormLabel className="font-normal">{t.startPaused}</FormLabel>
                  </FormItem>
                )}
              />
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || (!isEdit && selectedAccounts.length === 0)}>
                {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isEdit ? t.editCampaign : t.createCampaign}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
