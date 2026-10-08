import { useState } from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { useValidateSalesTaxAddress } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type { SalesTaxSettings, ValidateAddressInput } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { Field } from '../setup/field';
import { useSetupTexts } from '../setup/setup-texts';

/** The address as the user typed it, without empty fields (the server wants an address, not blanks). */
export function addressInput(fields: { line1: string; city: string; state: string; postalCode: string }): ValidateAddressInput {
  const input: ValidateAddressInput = { country: 'US' };
  if (fields.line1.trim()) input.line1 = fields.line1.trim();
  if (fields.city.trim()) input.city = fields.city.trim();
  if (fields.state.trim()) input.state = fields.state.trim().toUpperCase();
  if (fields.postalCode.trim()) input.postalCode = fields.postalCode.trim();
  return input;
}

/** Test how Avalara reads an address, before an invoice depends on it. Avalara only. */
export function AddressCheck({ settings }: Readonly<{ settings: SalesTaxSettings }>) {
  const { t } = useSetupTexts();
  const ta = t.engine.address;
  const validate = useValidateSalesTaxAddress();
  const [fields, setFields] = useState({ line1: '', city: '', state: '', postalCode: '' });
  const result = validate.data;
  const normalized = result?.normalized;

  if (settings.engine !== 'avalara') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{ta.title}</CardTitle>
          <CardDescription>{ta.unavailable}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const set = (key: keyof typeof fields) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setFields((current) => ({ ...current, [key]: event.target.value }));
  const empty = Object.values(fields).every((v) => v.trim() === '');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{ta.title}</CardTitle>
        <CardDescription>{ta.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!empty) validate.mutate(addressInput(fields));
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={ta.line1} htmlFor="address-line1" className="sm:col-span-2">
              <Input id="address-line1" value={fields.line1} onChange={set('line1')} autoComplete="off" />
            </Field>
            <Field label={ta.city} htmlFor="address-city">
              <Input id="address-city" value={fields.city} onChange={set('city')} autoComplete="off" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label={ta.state} htmlFor="address-state">
                <Input id="address-state" value={fields.state} onChange={set('state')} maxLength={2} autoComplete="off" />
              </Field>
              <Field label={ta.postalCode} htmlFor="address-zip">
                <Input id="address-zip" value={fields.postalCode} onChange={set('postalCode')} inputMode="numeric" autoComplete="off" />
              </Field>
            </div>
          </div>
          <Button type="submit" variant="outline" disabled={validate.isPending || empty}>
            {validate.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
            {validate.isPending ? ta.validating : ta.validate}
          </Button>
        </form>

        {validate.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{validate.error instanceof Error && validate.error.message ? validate.error.message : ta.error}</AlertDescription>
          </Alert>
        ) : null}

        {result ? (
          <div className="space-y-2 text-sm" data-testid="address-result">
            <p className="flex items-center gap-2 font-medium">
              {result.valid ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" aria-hidden />
              )}
              {result.valid ? ta.valid : ta.invalid}
            </p>
            {normalized ? (
              <p className="text-muted-foreground">
                {ta.normalized}:{' '}
                {[normalized.line1, normalized.city, [normalized.state, normalized.postalCode].filter(Boolean).join(' ')]
                  .filter(Boolean)
                  .join(', ')}
              </p>
            ) : null}
            {result.messages && result.messages.length > 0 ? (
              <ul className="list-disc pl-5 text-muted-foreground">
                {result.messages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
