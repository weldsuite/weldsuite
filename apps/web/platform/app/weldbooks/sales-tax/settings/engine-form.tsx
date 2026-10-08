import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useUpdateSalesTaxSettings } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import { SALES_TAX_ENGINES, type SalesTaxEngineId, type SalesTaxSettings } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { Field } from '../setup/field';
import { useSetupTexts } from '../setup/setup-texts';
import {
  buildEnginePayload,
  hasStoredCredentialsFor,
  isDirty,
  removeCredentialsPayload,
  settingsToForm,
  withoutSecrets,
  type EngineFormValues,
  type EngineProblem,
} from './settings-model';

export interface EngineFormProps {
  settings: SalesTaxSettings;
  canUpdate: boolean;
}

/**
 * Which engine works out the tax, and the customer's own credentials for it.
 *
 * The credentials are write-only: the server only says whether some are stored,
 * so the secret fields start empty and are emptied again after every save. A
 * stored set shows as "stored" with replace and remove, never as its value.
 */
export function EngineForm({ settings, canUpdate }: Readonly<EngineFormProps>) {
  const { t } = useSetupTexts();
  const te = t.engine;
  const save = useUpdateSalesTaxSettings();
  const form = useForm<EngineFormValues>({ defaultValues: settingsToForm(settings) });
  const values = form.watch();
  const [replacing, setReplacing] = useState(false);
  const [problems, setProblems] = useState<EngineProblem[]>([]);
  const [removeOpen, setRemoveOpen] = useState(false);

  const engine = values.engine;
  const stored = hasStoredCredentialsFor(settings, engine);
  // Stored credentials show as stored; typing new ones needs "Replace" first.
  const showSecretFields = engine !== 'manual' && (!stored || replacing);
  const dirty = isDirty(values, settings);

  // The saved settings changed (saved here or elsewhere): start from them again, with empty secret fields.
  useEffect(() => {
    form.reset(settingsToForm(settings));
    setReplacing(false);
    setProblems([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.engine, settings.hasCredentials, settings.config.companyCode, settings.config.environment]);

  const problemText: Record<EngineProblem, string> = {
    apiKey: t.validation.apiKey,
    accountId: t.validation.accountId,
    licenseKey: t.validation.licenseKey,
    bothCredentials: t.validation.bothCredentials,
    companyCode: t.validation.companyCode,
  };
  const has = (problem: EngineProblem) => problems.includes(problem);

  const choose = (next: SalesTaxEngineId) => {
    form.reset({ ...withoutSecrets(values), engine: next });
    setReplacing(false);
    setProblems([]);
    save.reset();
  };

  const submit = async () => {
    const { input, problems: found } = buildEnginePayload(values, stored);
    setProblems(found);
    if (!input) return;
    try {
      const saved = await save.mutateAsync(input);
      toast.success(te.saved);
      // Whatever was typed is gone from the form as soon as it is saved.
      form.reset(settingsToForm(saved));
      setReplacing(false);
    } catch {
      // The error shows under the form (save.error).
    }
  };

  const remove = async () => {
    try {
      const saved = await save.mutateAsync(removeCredentialsPayload());
      toast.success(te.credentials.removed);
      form.reset(settingsToForm(saved));
      setReplacing(false);
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : te.saveError);
    } finally {
      setRemoveOpen(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{te.title}</CardTitle>
        <CardDescription>{te.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <RadioGroup
          value={engine}
          onValueChange={(value) => choose(value as SalesTaxEngineId)}
          disabled={!canUpdate}
          className="grid gap-3 md:grid-cols-3"
          aria-label={te.title}
        >
          {SALES_TAX_ENGINES.map((id) => (
            <Label
              key={id}
              htmlFor={`engine-${id}`}
              className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
            >
              <RadioGroupItem value={id} id={`engine-${id}`} className="mt-0.5" />
              <span className="space-y-1">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {te.options[id].name}
                  {settings.engine === id ? <Badge variant="success">{te.current}</Badge> : null}
                </span>
                <span className="block text-xs text-muted-foreground">{te.options[id].description}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>

        {engine === 'manual' ? (
          <Alert role="note" data-testid="manual-warning">
            <AlertTitle>{te.manualWarning.title}</AlertTitle>
            <AlertDescription>{te.manualWarning.description}</AlertDescription>
          </Alert>
        ) : null}

        {engine === 'stripe_tax' ? (
          <div className="space-y-4">
            <h3 className="text-sm font-medium">{te.stripe.title}</h3>
            <p className="text-sm text-muted-foreground">{te.stripe.note}</p>
          </div>
        ) : null}

        {engine === 'avalara' ? (
          <div className="space-y-4">
            <h3 className="text-sm font-medium">{te.avalara.title}</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={te.avalara.companyCode}
                htmlFor="engine-company-code"
                help={te.avalara.companyCodeHelp}
                error={has('companyCode') ? problemText.companyCode : undefined}
              >
                <Input
                  id="engine-company-code"
                  autoComplete="off"
                  disabled={!canUpdate}
                  {...form.register('companyCode')}
                  aria-invalid={has('companyCode') || undefined}
                />
              </Field>
              <Field label={te.avalara.environment} htmlFor="engine-environment">
                <Controller
                  control={form.control}
                  name="environment"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange} disabled={!canUpdate}>
                      <SelectTrigger id="engine-environment" aria-label={te.avalara.environment}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sandbox">{te.avalara.sandbox}</SelectItem>
                        <SelectItem value="production">{te.avalara.production}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
            </div>
          </div>
        ) : null}

        {engine !== 'manual' ? (
          <div className="space-y-3">
            {stored && !replacing ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 p-3" data-testid="credentials-stored">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{te.credentials.stored}</p>
                    <p className="text-xs text-muted-foreground">{te.credentials.storedHelp}</p>
                  </div>
                </div>
                {canUpdate ? (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
                      <KeyRound className="mr-1 h-3.5 w-3.5" aria-hidden />
                      {te.credentials.replace}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setRemoveOpen(true)}>
                      {te.credentials.remove}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {showSecretFields ? (
              <div className="space-y-4">
                {!stored ? <p className="text-sm text-muted-foreground">{te.credentials.notStored}</p> : null}
                {engine === 'stripe_tax' ? (
                  <Field
                    label={te.stripe.apiKey}
                    htmlFor="engine-api-key"
                    help={te.stripe.apiKeyHelp}
                    error={has('apiKey') ? problemText.apiKey : undefined}
                  >
                    <Input
                      id="engine-api-key"
                      type="password"
                      autoComplete="new-password"
                      spellCheck={false}
                      disabled={!canUpdate}
                      {...form.register('apiKey')}
                      aria-invalid={has('apiKey') || undefined}
                    />
                  </Field>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label={te.avalara.accountId}
                      htmlFor="engine-account-id"
                      error={has('accountId') ? problemText.accountId : has('bothCredentials') ? problemText.bothCredentials : undefined}
                    >
                      <Input
                        id="engine-account-id"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={!canUpdate}
                        {...form.register('accountId')}
                        aria-invalid={has('accountId') || has('bothCredentials') || undefined}
                      />
                    </Field>
                    <Field
                      label={te.avalara.licenseKey}
                      htmlFor="engine-license-key"
                      error={has('licenseKey') ? problemText.licenseKey : undefined}
                    >
                      <Input
                        id="engine-license-key"
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        disabled={!canUpdate}
                        {...form.register('licenseKey')}
                        aria-invalid={has('licenseKey') || undefined}
                      />
                    </Field>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">{te.credentials.encrypted}</p>
                {stored ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      form.reset(withoutSecrets(values));
                      setReplacing(false);
                      setProblems([]);
                    }}
                  >
                    {te.credentials.keep}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {save.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{save.error instanceof Error && save.error.message ? save.error.message : te.saveError}</AlertDescription>
          </Alert>
        ) : null}

        {canUpdate ? (
          <div className="flex justify-end">
            <Button type="button" onClick={() => void submit()} disabled={save.isPending || !dirty}>
              {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
              {save.isPending ? te.saving : te.save}
            </Button>
          </div>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={te.credentials.removeDialog.title}
        description={te.credentials.removeDialog.description}
        confirmLabel={te.credentials.removeDialog.confirm}
        cancelLabel={t.common.cancel}
        variant="destructive"
        loading={save.isPending}
        onConfirm={remove}
      />
    </Card>
  );
}
