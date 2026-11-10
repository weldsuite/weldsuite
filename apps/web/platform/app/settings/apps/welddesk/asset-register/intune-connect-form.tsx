import { useState } from 'react';
import { toast } from 'sonner';
import { isEntraTenantId, type AssetSourceTestResult } from '@weldsuite/core-api-client/schemas/asset-sources';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useCreateAssetSource, useTestNewAssetSource } from '@/hooks/queries/use-asset-source-queries';
import { useI18n } from '@/lib/i18n/provider';
import { apiErrorInfo, assetSourceErrorText } from './asset-source-errors';

interface FormValues {
  name: string;
  tenantId: string;
  clientId: string;
  secret: string;
}

type FieldErrors = Partial<Record<keyof FormValues, string>>;

const EMPTY: FormValues = { name: '', tenantId: '', clientId: '', secret: '' };

/**
 * The connection a customer makes with their own Entra app registration: the
 * five setup steps, then name, tenant id, client id and the client secret.
 * "Test connection" tries the credentials without saving them; "Connect" saves.
 */
export function IntuneConnectForm() {
  const { t } = useI18n();
  const ti = t.assetSources.intune;
  const tf = ti.form;
  const create = useCreateAssetSource();
  const test = useTestNewAssetSource();

  const [values, setValues] = useState<FormValues>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<AssetSourceTestResult | null>(null);

  const set = (field: keyof FormValues) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setValues((prev) => ({ ...prev, [field]: event.target.value }));
    setResult(null);
  };

  const validate = (fields: Array<keyof FormValues>): boolean => {
    const next: FieldErrors = {};
    if (fields.includes('name') && values.name.trim() === '') next.name = tf.nameRequired;
    if (fields.includes('tenantId') && !isEntraTenantId(values.tenantId.trim())) next.tenantId = tf.tenantInvalid;
    if (fields.includes('clientId') && values.clientId.trim() === '') next.clientId = tf.clientRequired;
    if (fields.includes('secret') && values.secret.trim() === '') next.secret = tf.secretRequired;
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const credentials = () => ({
    config: { tenantId: values.tenantId.trim(), clientId: values.clientId.trim() },
    secret: values.secret.trim(),
  });

  const runTest = async () => {
    setFormError(null);
    if (!validate(['tenantId', 'clientId', 'secret'])) return;
    try {
      setResult(await test.mutateAsync(credentials()));
    } catch {
      setResult(null);
      setFormError(tf.testFailed);
    }
  };

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!validate(['name', 'tenantId', 'clientId', 'secret'])) return;
    try {
      await create.mutateAsync({ name: values.name.trim(), ...credentials() });
      toast.success(tf.connected);
      setValues(EMPTY);
      setResult(null);
    } catch (err) {
      const { status, code } = apiErrorInfo(err);
      if (status === 409 && code === 'asset_register_missing') setFormError(ti.errors.asset_register_missing);
      else if (status === 409) setFormError(tf.duplicate);
      else setFormError(tf.connectFailed);
    }
  };

  const busy = create.isPending || test.isPending;

  return (
    <div className="space-y-5" data-testid="intune-connect">
      <p className="text-sm text-muted-foreground">{ti.notConnected}</p>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{ti.stepsTitle}</h3>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{ti.steps.register}</li>
          <li>{ti.steps.copyIds}</li>
          <li>{ti.steps.permission}</li>
          <li>{ti.steps.consent}</li>
          <li>{ti.steps.secret}</li>
        </ol>
      </div>

      <form onSubmit={connect} className="space-y-4" noValidate>
        <ErrorBanner error={formError} onDismiss={() => setFormError(null)} />

        <div className="space-y-1.5">
          <Label htmlFor="intune-name">{tf.name}</Label>
          <Input id="intune-name" value={values.name} onChange={set('name')} placeholder={tf.namePlaceholder} aria-invalid={!!errors.name} />
          {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="intune-tenant">{tf.tenantId}</Label>
          <Input
            id="intune-tenant"
            value={values.tenantId}
            onChange={set('tenantId')}
            placeholder={tf.tenantIdPlaceholder}
            autoComplete="off"
            aria-invalid={!!errors.tenantId}
          />
          {errors.tenantId && <p className="text-xs text-destructive">{errors.tenantId}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="intune-client">{tf.clientId}</Label>
          <Input
            id="intune-client"
            value={values.clientId}
            onChange={set('clientId')}
            placeholder={tf.clientIdPlaceholder}
            autoComplete="off"
            aria-invalid={!!errors.clientId}
          />
          {errors.clientId && <p className="text-xs text-destructive">{errors.clientId}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="intune-secret">{tf.secret}</Label>
          <Input
            id="intune-secret"
            type="password"
            value={values.secret}
            onChange={set('secret')}
            autoComplete="new-password"
            aria-invalid={!!errors.secret}
          />
          <p className="text-xs text-muted-foreground">{tf.secretHelp}</p>
          {errors.secret && <p className="text-xs text-destructive">{errors.secret}</p>}
        </div>

        {result?.ok === true && (
          <InfoBanner variant="success" data-testid="intune-test-ok">
            {result.deviceCount > 0 ? tf.testOk.replace('{count}', String(result.deviceCount)) : tf.testOkNone}
          </InfoBanner>
        )}
        {result?.ok === false && (
          <InfoBanner variant="danger" data-testid="intune-test-failed">
            {assetSourceErrorText(ti.errors, result.code, result.message)}
          </InfoBanner>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void runTest()} disabled={busy}>
            {test.isPending ? tf.testing : tf.testConnection}
          </Button>
          <Button type="submit" disabled={busy} data-testid="intune-connect-submit">
            {create.isPending ? tf.connecting : tf.connect}
          </Button>
        </div>
      </form>
    </div>
  );
}
