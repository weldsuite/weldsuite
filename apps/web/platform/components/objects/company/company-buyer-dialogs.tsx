/**
 * The two buyer dialogs of the company panel (phase 6): inviting a buyer (email,
 * name, role, spend limit, whether to send the invitation now) and editing one
 * (role, spend limit, disabled). Both are React Hook Form + Zod forms that send
 * through the buyer hooks; an edit sends only what changed.
 */

import { useMemo } from 'react';
import { useForm, useFormContext } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  useInviteCommerceBuyer,
  useUpdateCommerceBuyer,
  type Buyer,
  type BuyerRole,
} from '@/hooks/queries/use-commerce-buyers-queries';
import { useCommerceSettings } from '@/hooks/queries/use-commerce-orders-queries';
import { formSchemaOptions } from '@/app/weldstash/lib/form';
import { getTranslations } from '@/lib/i18n';
import {
  BUYER_ROLES,
  buildEditSchema,
  buildInviteSchema,
  buyerDisplayName,
  buyerErrorMessage,
  buyerRoleHint,
  buyerRoleLabel,
  editValuesFromBuyer,
  emptyInviteValues,
  toBuyerPatch,
  toInviteInput,
  type EditFormValues,
  type InviteFormValues,
} from '@/app/weldcommerce/lib/buyers';
import { fill } from '@/app/weldcommerce/lib/text';

const FALLBACK_CURRENCY = 'EUR';

/** The currency a new limit starts with: the workspace's default, which only members with commerce access can read. */
function useDefaultCurrency(): string {
  return useCommerceSettings().data?.data.defaultCurrency ?? FALLBACK_CURRENCY;
}

function RoleField({ idPrefix }: Readonly<{ idPrefix: string }>) {
  const t = getTranslations('commerce').buyers.form;
  const form = useFormContext<{ role: BuyerRole }>();
  return (
    <FormField
      control={form.control}
      name="role"
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t.role}</FormLabel>
          <FormControl>
            <RadioGroup value={field.value} onValueChange={field.onChange} className="gap-2.5">
              {BUYER_ROLES.map((role) => (
                <div key={role} className="flex items-start gap-2.5">
                  <RadioGroupItem id={`${idPrefix}-role-${role}`} value={role} className="mt-0.5" />
                  <Label htmlFor={`${idPrefix}-role-${role}`} className="block min-w-0 cursor-pointer font-normal">
                    <span className="block text-sm font-medium">{buyerRoleLabel(role)}</span>
                    <span className="block text-xs text-muted-foreground">{buyerRoleHint(role)}</span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** The spend limit and its currency, side by side: the currency is only asked for with an amount. */
function LimitFields() {
  const t = getTranslations('commerce').buyers.form;
  const form = useFormContext<{ spendLimit: string; currency: string }>();
  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
      <FormField
        control={form.control}
        name="spendLimit"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.spendLimit}</FormLabel>
            <FormControl>
              <Input {...field} inputMode="decimal" autoComplete="off" enterKeyHint="next" className="tabular-nums" />
            </FormControl>
            <FormDescription>{t.spendLimitHint}</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="currency"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.currency}</FormLabel>
            <FormControl>
              <Input
                {...field}
                onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                maxLength={3}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                enterKeyHint="done"
                className="uppercase"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

function DialogButtons({ submitting, label, busyLabel, onCancel }: Readonly<{ submitting: boolean; label: string; busyLabel: string; onCancel: () => void }>) {
  const common = getTranslations('common');
  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onCancel}>
        {common.actions.cancel}
      </Button>
      <Button type="submit" disabled={submitting}>
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
        {submitting ? busyLabel : label}
      </Button>
    </DialogFooter>
  );
}

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

function TextField({
  name,
  label,
  type = 'text',
  autoComplete = 'off',
  ...rest
}: Readonly<{ name: 'email' | 'firstName' | 'lastName'; label: string; type?: string; autoComplete?: string; inputMode?: 'email'; required?: boolean }>) {
  const form = useFormContext<InviteFormValues>();
  const identifier = name === 'email';
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              {...field}
              {...rest}
              type={type}
              autoComplete={autoComplete}
              autoCapitalize={identifier ? 'none' : 'words'}
              spellCheck={false}
              enterKeyHint="next"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function SendInviteField() {
  const t = getTranslations('commerce').buyers.form;
  const form = useFormContext<InviteFormValues>();
  return (
    <FormField
      control={form.control}
      name="sendInvite"
      render={({ field }) => (
        <FormItem className="flex items-center justify-between gap-6 space-y-0">
          <div className="space-y-1">
            <FormLabel>{t.sendInvite}</FormLabel>
            <FormDescription>{t.sendInviteHint}</FormDescription>
          </div>
          <FormControl>
            <Switch checked={field.value} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

export function InviteBuyerDialog({
  companyId,
  companyName,
  open,
  onOpenChange,
}: Readonly<{ companyId: string; companyName: string; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const t = getTranslations('commerce').buyers;
  const ti = t.inviteDialog;
  const invite = useInviteCommerceBuyer();
  const currency = useDefaultCurrency();
  const schema = useMemo(() => buildInviteSchema(), []);
  const form = useForm<InviteFormValues>({
    resolver: zodResolver(schema, formSchemaOptions()),
    defaultValues: emptyInviteValues(currency),
  });

  const onSubmit = async (values: InviteFormValues) => {
    try {
      await invite.mutateAsync(toInviteInput(companyId, values));
      toast.success(fill(values.sendInvite ? ti.toastInvited : ti.toastAdded, { email: values.email.trim() }));
      onOpenChange(false);
    } catch (err) {
      toast.error(buyerErrorMessage(err, t.errors.generic));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{ti.title}</DialogTitle>
          <DialogDescription>{fill(ti.description, { company: companyName })}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
            <TextField name="email" label={t.form.email} type="email" inputMode="email" required />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField name="firstName" label={t.form.firstName} autoComplete="off" />
              <TextField name="lastName" label={t.form.lastName} autoComplete="off" />
            </div>
            <RoleField idPrefix="invite" />
            <LimitFields />
            <SendInviteField />
            <DialogButtons submitting={form.formState.isSubmitting} label={ti.submit} busyLabel={ti.submitting} onCancel={() => onOpenChange(false)} />
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

function DisabledField() {
  const t = getTranslations('commerce').buyers.form;
  const form = useFormContext<EditFormValues>();
  return (
    <FormField
      control={form.control}
      name="disabled"
      render={({ field }) => (
        <FormItem className="flex items-center justify-between gap-6 space-y-0">
          <div className="space-y-1">
            <FormLabel>{t.disabled}</FormLabel>
            <FormDescription>{t.disabledHint}</FormDescription>
          </div>
          <FormControl>
            <Switch checked={field.value} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

export function EditBuyerDialog({
  buyer,
  open,
  onOpenChange,
}: Readonly<{ buyer: Buyer; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const t = getTranslations('commerce').buyers;
  const te = t.editDialog;
  const update = useUpdateCommerceBuyer();
  const currency = useDefaultCurrency();
  const schema = useMemo(() => buildEditSchema(), []);
  const form = useForm<EditFormValues>({
    resolver: zodResolver(schema, formSchemaOptions()),
    defaultValues: editValuesFromBuyer(buyer, currency),
  });

  const onSubmit = async (values: EditFormValues) => {
    const data = toBuyerPatch(buyer, values);
    if (Object.keys(data).length === 0) {
      onOpenChange(false);
      return;
    }
    try {
      await update.mutateAsync({ id: buyer.id, data });
      toast.success(te.toast);
      onOpenChange(false);
    } catch (err) {
      toast.error(buyerErrorMessage(err, t.errors.generic));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{fill(te.title, { name: buyerDisplayName(buyer) })}</DialogTitle>
          <DialogDescription>
            {buyer.email} · {te.description}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
            <RoleField idPrefix={`edit-${buyer.id}`} />
            <LimitFields />
            <DisabledField />
            <DialogButtons submitting={form.formState.isSubmitting} label={te.submit} busyLabel={te.submitting} onCancel={() => onOpenChange(false)} />
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
