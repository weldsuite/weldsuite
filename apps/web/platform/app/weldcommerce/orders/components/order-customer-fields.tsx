/**
 * Who the order is for: a CRM company and a contact person (picked with the
 * platform's record picker), and the name, email and phone printed on the
 * order. Picking a record fills the name and email when they are still blank.
 */

import { useState } from 'react';
import { Building, User } from 'lucide-react';
import { useFormContext } from 'react-hook-form';
import { Button } from '@weldsuite/ui/components/button';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { RecordSelectionModal, type RecordKind, type SelectableRecord } from '@/components/objects/_shared/record-selection-modal';
import { getTranslations } from '@/lib/i18n';
import type { OrderFormValues } from '../../lib/order-form';

function LinkedRecord({
  kind,
  name,
  disabled,
  onChoose,
  onClear,
}: Readonly<{ kind: RecordKind; name: string; disabled: boolean; onChoose: () => void; onClear: () => void }>) {
  const t = getTranslations('commerce').orders.form;
  const Icon = kind === 'company' ? Building : User;
  const label = kind === 'company' ? t.company : t.person;
  const choose = kind === 'company' ? t.chooseCompany : t.choosePerson;

  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex min-h-9 items-center gap-2 rounded-md border px-3 py-1.5">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className={name ? 'min-w-0 flex-1 truncate text-sm' : 'min-w-0 flex-1 truncate text-sm text-muted-foreground'}>
          {name || choose}
        </span>
        {!disabled && (
          <>
            <Button type="button" variant="ghost" size="sm" className="h-7" onClick={onChoose}>
              {name ? t.change : choose}
            </Button>
            {name && (
              <Button type="button" variant="ghost" size="sm" className="h-7" onClick={onClear}>
                {t.remove}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function OrderCustomerFields({ disabled }: Readonly<{ disabled: boolean }>) {
  const t = getTranslations('commerce').orders.form;
  const form = useFormContext<OrderFormValues>();
  const [picking, setPicking] = useState<RecordKind | null>(null);

  const fillBlank = (name: 'customerName' | 'customerEmail', value: string | undefined) => {
    if (value && !form.getValues(name).trim()) form.setValue(name, value, { shouldDirty: true });
  };

  const select = (record: SelectableRecord) => {
    if (record.kind === 'company') {
      form.setValue('companyId', record.id, { shouldDirty: true });
      form.setValue('companyName', record.displayName, { shouldDirty: true });
    } else {
      form.setValue('personId', record.id, { shouldDirty: true });
      form.setValue('personName', record.displayName, { shouldDirty: true });
      fillBlank('customerName', record.displayName);
    }
    fillBlank('customerEmail', record.email);
    setPicking(null);
  };

  const clear = (kind: RecordKind) => {
    if (kind === 'company') {
      form.setValue('companyId', null, { shouldDirty: true });
      form.setValue('companyName', '', { shouldDirty: true });
    } else {
      form.setValue('personId', null, { shouldDirty: true });
      form.setValue('personName', '', { shouldDirty: true });
    }
  };

  const companyName = form.watch('companyName');
  const personName = form.watch('personName');
  // An order loaded for editing knows its person only by id.
  const personLabel = personName || (form.watch('personId') ? form.getValues('customerName') : '');

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <LinkedRecord
          kind="company"
          name={companyName}
          disabled={disabled}
          onChoose={() => setPicking('company')}
          onClear={() => clear('company')}
        />
        <LinkedRecord
          kind="person"
          name={personLabel}
          disabled={disabled}
          onChoose={() => setPicking('person')}
          onClear={() => clear('person')}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <FormField
          control={form.control}
          name="customerName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.customerName}</FormLabel>
              <FormControl>
                <Input {...field} autoComplete="off" disabled={disabled} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="customerEmail"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.customerEmail}</FormLabel>
              <FormControl>
                <Input {...field} type="email" autoComplete="off" spellCheck={false} disabled={disabled} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="customerPhone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.customerPhone}</FormLabel>
              <FormControl>
                <Input {...field} type="tel" autoComplete="off" disabled={disabled} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      {picking && (
        <RecordSelectionModal
          open
          kind={picking}
          onOpenChange={(open) => !open && setPicking(null)}
          onSelectRecord={select}
        />
      )}
    </div>
  );
}
