import { useState } from 'react';
import { toast } from 'sonner';
import type { AiKeySource, AiProviderState } from '@weldsuite/app-api-client/schemas/ai-settings';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Input } from '@weldsuite/ui/components/input';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import { AiMetaBadge, useAiProviderName } from '@/components/ai/ai-meta-badge';
import {
  useRemoveAiKey,
  useSetAiKey,
  useTestAiKey,
  useUpdateAiSettings,
} from '@/hooks/queries/use-ai-settings-queries';
import { errorMessage } from '@/app/agents/components/chat/labels';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { OutsideEuConfirm } from './outside-eu-confirm';

/** The key source a freshly enabled provider starts with: WeldSuite's account when the install has one. */
export function defaultKeySource(provider: AiProviderState): AiKeySource {
  return provider.keySources.includes('weldsuite') ? 'weldsuite' : 'own';
}

/**
 * One provider on the Providers list: its region, the switch (the install's
 * default has none), and for an enabled one the key source, the masked key
 * field, the saved hint, Test and the key's status.
 */
export function ProviderCard({ provider, canManage }: Readonly<{ provider: AiProviderState; canManage: boolean }>) {
  const { t } = useI18n();
  const ta = t.settings.ai;
  const name = useAiProviderName()(provider.id);
  const update = useUpdateAiSettings();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const keySource = provider.keySource ?? defaultKeySource(provider);
  let regionText = ta.providers.outsideEu;
  if (provider.region === 'eu') {
    regionText = provider.install ? ta.providers.euDefault : ta.providers.eu;
  }

  const save = (input: Parameters<typeof update.mutateAsync>[0]) =>
    update.mutateAsync(input).catch((err: unknown) => {
      toast.error(errorMessage(err, ta.messages.saveFailed));
      throw err;
    });

  const disable = () => {
    void save({
      providers: { [provider.id]: { enabled: false, keySource } },
    }).catch(() => undefined);
  };

  return (
    <div className="rounded-xl border p-4" data-testid={`ai-provider-${provider.id}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{name}</h3>
            <AiMetaBadge ai={{ provider: provider.id, region: provider.region }} hideIcon />
          </div>
          <p className="text-sm text-muted-foreground">{regionText}</p>
          {!provider.install && !provider.offered && (
            <p className="text-sm text-muted-foreground">{ta.providers.notOffered}</p>
          )}
        </div>
        {!provider.install && (
          <Switch
            checked={provider.enabled}
            disabled={!canManage || update.isPending || (!provider.enabled && !provider.offered)}
            aria-label={ta.providers.enableLabel.replace('{provider}', name)}
            onCheckedChange={(on) => (on ? setConfirmOpen(true) : disable())}
          />
        )}
      </div>

      {provider.enabled && !provider.install && (
        <div className="mt-4 space-y-4 border-t pt-4">
          {provider.keySources.length > 1 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{ta.providers.keySourceTitle}</legend>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={ta.providers.keySourceTitle}>
                {provider.keySources.map((source) => (
                  <button
                    key={source}
                    type="button"
                    role="radio"
                    aria-checked={keySource === source}
                    disabled={!canManage || update.isPending}
                    onClick={() => {
                      if (source !== keySource) {
                        void save({
                          providers: {
                            [provider.id]: { enabled: true, keySource: source },
                          },
                        }).catch(() => undefined);
                      }
                    }}
                    className={cn(
                      'rounded-lg border p-3 text-left text-sm transition-colors',
                      keySource === source ? 'border-foreground bg-accent/60' : 'hover:border-foreground/25',
                    )}
                  >
                    {source === 'weldsuite' ? ta.providers.keySourceWeldsuite : ta.providers.keySourceOwn}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {keySource === 'own' && <OwnKey provider={provider} canManage={canManage} />}
          {provider.enabledBy && provider.enabledAt && (
            <p className="text-xs text-muted-foreground">
              {ta.providers.enabledBy
                .replace('{user}', provider.enabledBy)
                .replace('{date}', new Date(provider.enabledAt).toLocaleDateString())}
            </p>
          )}
        </div>
      )}

      <OutsideEuConfirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        provider={provider.id}
        onConfirm={async () => {
          try {
            await save({
              providers: { [provider.id]: { enabled: true, keySource } },
              acknowledgedOutsideEu: true,
            });
            setConfirmOpen(false);
          } catch {
            // The toast is shown; keep the dialog open.
          }
        }}
      />
    </div>
  );
}

/** The workspace's own key for a provider: masked field, saved hint, Test, status, Remove. */
function OwnKey({ provider, canManage }: Readonly<{ provider: AiProviderState; canManage: boolean }>) {
  const { t, language } = useI18n();
  const ta = t.settings.ai.key;
  const [apiKey, setApiKey] = useState('');
  const [removeOpen, setRemoveOpen] = useState(false);
  const setKey = useSetAiKey();
  const testKey = useTestAiKey();
  const removeKey = useRemoveAiKey();
  const key = provider.key;

  const onSave = () => {
    setKey.mutate(
      { provider: provider.id, apiKey: apiKey.trim() },
      {
        onSuccess: () => {
          // The key never stays in the page: only the hint the server sends back.
          setApiKey('');
          toast.success(ta.saved);
        },
        onError: (err) => toast.error(errorMessage(err, ta.rejected)),
      },
    );
  };

  const onTest = () => {
    testKey.mutate(provider.id, {
      onSuccess: (res) =>
        res.data.status === 'ok'
          ? toast.success(ta.tested)
          : toast.error(ta.testFailed.replace('{error}', res.data.lastError ?? '')),
      onError: (err) => toast.error(ta.testFailed.replace('{error}', errorMessage(err, ''))),
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor={`ai-key-${provider.id}`}>
          {ta.label}
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={`ai-key-${provider.id}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 font-mono"
            placeholder={ta.placeholder}
            value={apiKey}
            disabled={!canManage}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <Button
            type="button"
            size="sm"
            disabled={!canManage || apiKey.trim().length < 8 || setKey.isPending}
            onClick={onSave}
          >
            {setKey.isPending ? ta.saving : ta.save}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{ta.hintHelp}</p>
      </div>

      {key ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {ta.hint.replace('{hint}', key.hint)}
          </code>
          <SoftBadge tone={key.status === 'ok' ? 'success' : 'danger'}>
            {key.status === 'ok' ? ta.statusOk : ta.statusFailing}
          </SoftBadge>
          {key.lastCheckedAt && (
            <span className="text-xs text-muted-foreground">
              {ta.lastChecked.replace('{time}', new Date(key.lastCheckedAt).toLocaleString(language))}
            </span>
          )}
          {key.status === 'failing' && key.lastError && (
            <span className="w-full text-xs text-destructive">{key.lastError}</span>
          )}
          <span className="ml-auto flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canManage || testKey.isPending}
              onClick={onTest}
            >
              {testKey.isPending ? ta.testing : ta.test}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={!canManage} onClick={() => setRemoveOpen(true)}>
              {ta.remove}
            </Button>
          </span>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{ta.none}</p>
      )}

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        variant="destructive"
        title={ta.removeTitle}
        description={ta.removeDescription}
        confirmLabel={ta.remove}
        onConfirm={async () => {
          try {
            await removeKey.mutateAsync(provider.id);
            toast.success(ta.removed);
            setRemoveOpen(false);
          } catch (err) {
            toast.error(errorMessage(err, t.settings.ai.messages.saveFailed));
          }
        }}
      />
    </div>
  );
}
