import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useFiscalSettings, useUpdateFiscalSettings } from '@/hooks/queries/use-weldbooks-br-queries';
import type {
  FiscalEnvironment,
  UpdateFiscalSettingsInput,
  UpdateFiscalSettingsResult,
} from '@/lib/api/domains/weldbooks-fiscal-documents';
import { useI18n } from '@/lib/i18n/provider';

/**
 * Brazil: the Focus NFe connection that issues NF-e and NFS-e: environment
 * (homologação for tests, produção for real documents), the company token of
 * that environment (write-only: it is never shown again), the NFS-e standard
 * and the optional provider settings. Saving registers the provider's webhooks,
 * so statuses arrive without a manual refresh.
 */
export function FiscalSettingsCard() {
  const { t } = useI18n();
  const tf = t.weldbooksBr.fiscalSettings;
  const canUpdate = useCan('accounts:update');
  const settings = useFiscalSettings();
  const update = useUpdateFiscalSettings();

  const [environment, setEnvironment] = useState<FiscalEnvironment>('homologacao');
  const [token, setToken] = useState('');
  const [nfseStandard, setNfseStandard] = useState<'nacional' | 'municipal'>('nacional');
  const [dpsSeries, setDpsSeries] = useState('');
  const [simplesCreditRate, setSimplesCreditRate] = useState('');
  const [codigoTributario, setCodigoTributario] = useState('');
  const [result, setResult] = useState<UpdateFiscalSettingsResult | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  const data = settings.data;
  useEffect(() => {
    if (!data) return;
    setEnvironment(data.environment);
    setNfseStandard(data.nfseStandard);
    setDpsSeries(data.dpsSeries ?? '');
    setSimplesCreditRate(data.simplesCreditRate != null ? String(data.simplesCreditRate) : '');
    setCodigoTributario(data.codigoTributarioMunicipio ?? '');
  }, [data]);

  const hasTokenForSelection = data?.credentialEnvironments.includes(environment) ?? false;
  const rateInvalid = simplesCreditRate.trim() !== '' && !(Number(simplesCreditRate.replace(',', '.')) >= 0 && Number(simplesCreditRate.replace(',', '.')) <= 100);

  const buildInput = (): UpdateFiscalSettingsInput => {
    const input: UpdateFiscalSettingsInput = { environment, nfseStandard };
    if (token.trim()) input.token = token.trim();
    if (dpsSeries.trim()) input.dpsSeries = dpsSeries.trim();
    if (simplesCreditRate.trim()) input.simplesCreditRate = Number(simplesCreditRate.replace(',', '.'));
    if (codigoTributario.trim()) input.codigoTributarioMunicipio = codigoTributario.trim();
    return input;
  };

  const save = () => {
    update.mutate(buildInput(), {
      onSuccess: (res) => {
        setResult(res);
        setToken('');
        toast.success(tf.saved);
      },
      onError: (err) => toast.error(tf.saveFailed, { description: err instanceof Error ? err.message : undefined }),
    });
  };

  const removeToken = () => {
    setRemoveOpen(false);
    update.mutate(
      { environment, token: null },
      {
        onSuccess: (res) => {
          setResult(res);
          toast.success(tf.tokenRemoved);
        },
        onError: (err) => toast.error(tf.saveFailed, { description: err instanceof Error ? err.message : undefined }),
      },
    );
  };

  const envLabel = (env: FiscalEnvironment) => (env === 'producao' ? tf.production : tf.homologation);

  return (
    <Card data-testid="fiscal-settings-card">
      <CardHeader>
        <CardTitle>{tf.title}</CardTitle>
        <CardDescription>{tf.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {settings.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={tf.loading} />}
        {settings.isError && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription className="flex items-center justify-between gap-3">
              <span>{tf.loadFailed}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => void settings.refetch()}>
                {tf.retry}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {data && (
          <>
            {!data.credentialsReadable && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription>{tf.unreadable}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline">{tf.provider}</Badge>
              {data.environments.map((env) => (
                <Badge key={env} variant={data.credentialEnvironments.includes(env) ? 'default' : 'secondary'}>
                  {envLabel(env)}: {data.credentialEnvironments.includes(env) ? tf.tokenStored : tf.noToken}
                </Badge>
              ))}
              <Badge variant={data.webhook.registered ? 'default' : 'secondary'} data-testid="webhook-status">
                {data.webhook.registered ? tf.webhookRegistered : tf.webhookMissing}
              </Badge>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="fiscal-environment">{tf.environment}</Label>
                <Select value={environment} onValueChange={(v) => setEnvironment(v as FiscalEnvironment)} disabled={!canUpdate}>
                  <SelectTrigger id="fiscal-environment">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {data.environments.map((env) => (
                      <SelectItem key={env} value={env}>
                        {envLabel(env)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {environment === 'producao' ? tf.productionHelp : tf.homologationHelp}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="fiscal-token">{tf.token.replace('{environment}', envLabel(environment))}</Label>
                <Input
                  id="fiscal-token"
                  type="password"
                  autoComplete="off"
                  data-1p-ignore
                  value={token}
                  disabled={!canUpdate}
                  placeholder={hasTokenForSelection ? tf.tokenPlaceholderStored : tf.tokenPlaceholder}
                  onChange={(e) => setToken(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{tf.tokenHelp}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="fiscal-nfse">{tf.nfseStandard}</Label>
                <Select value={nfseStandard} onValueChange={(v) => setNfseStandard(v as 'nacional' | 'municipal')} disabled={!canUpdate}>
                  <SelectTrigger id="fiscal-nfse">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nacional">{t.weldbooksBr.entity.nfseStandards.nacional}</SelectItem>
                    <SelectItem value="municipal">{t.weldbooksBr.entity.nfseStandards.municipal}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="fiscal-dps">{tf.dpsSeries}</Label>
                <Input id="fiscal-dps" value={dpsSeries} disabled={!canUpdate} onChange={(e) => setDpsSeries(e.target.value)} />
                <p className="text-xs text-muted-foreground">{tf.dpsSeriesHelp}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="fiscal-credit">{tf.simplesCreditRate}</Label>
                <Input
                  id="fiscal-credit"
                  inputMode="decimal"
                  value={simplesCreditRate}
                  disabled={!canUpdate}
                  aria-invalid={rateInvalid}
                  onChange={(e) => setSimplesCreditRate(e.target.value)}
                />
                {rateInvalid ? (
                  <p className="text-sm text-destructive">{tf.simplesCreditRateInvalid}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">{tf.simplesCreditRateHelp}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="fiscal-ctm">{tf.codigoTributario}</Label>
                <Input id="fiscal-ctm" value={codigoTributario} disabled={!canUpdate} onChange={(e) => setCodigoTributario(e.target.value)} />
                <p className="text-xs text-muted-foreground">{tf.codigoTributarioHelp}</p>
              </div>
            </div>

            {canUpdate && (
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={save} disabled={update.isPending || rateInvalid}>
                  {update.isPending ? tf.saving : tf.save}
                </Button>
                {hasTokenForSelection && (
                  <Button type="button" variant="outline" className="text-destructive" onClick={() => setRemoveOpen(true)} disabled={update.isPending}>
                    {tf.removeToken}
                  </Button>
                )}
              </div>
            )}
            {!canUpdate && <p className="text-sm text-muted-foreground">{tf.readOnly}</p>}

            {result && (
              <div className="space-y-2" data-testid="fiscal-settings-result">
                {result.webhookUrl && (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden />
                    {tf.webhookUrl}: <span className="break-all font-mono text-xs">{result.webhookUrl}</span>
                  </p>
                )}
                {result.warnings.length > 0 && (
                  <Alert>
                    <AlertTriangle />
                    <AlertDescription>
                      <ul className="list-disc space-y-1 pl-5 text-sm">
                        {result.warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={tf.removeTitle}
        description={tf.removeDescription.replace('{environment}', envLabel(environment))}
        confirmLabel={tf.removeToken}
        cancelLabel={tf.cancel}
        loading={update.isPending}
        onConfirm={removeToken}
      />
    </Card>
  );
}
