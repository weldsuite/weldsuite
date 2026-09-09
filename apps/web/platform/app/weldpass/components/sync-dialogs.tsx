/** Dialogs for adding a provider API token and a sync target. */

import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useTranslations } from '@weldsuite/i18n/client';
import type {
  WeldPassCredential,
  WeldPassEnvironment,
  WeldPassProviderId,
  WeldPassSyncTargetConfig,
} from '@weldsuite/app-api-client/domains/weldpass';
import {
  useCreateWeldPassCredential,
  useCreateWeldPassSyncTarget,
} from '@/hooks/queries/use-weldpass-queries';
import { ErrorBanner, errorMessage } from './shared';

const PROVIDER_IDS: WeldPassProviderId[] = [
  'cloudflare_workers',
  'cloudflare_pages',
  'vercel',
];

/** One-line description of where a target points. */
export function describeConfig(config: WeldPassSyncTargetConfig): string {
  if (config.provider === 'cloudflare_workers') return config.scriptName;
  if (config.provider === 'cloudflare_pages') {
    return `${config.projectName} (${config.environment})`;
  }
  return `${config.projectId} → ${config.targets.join(', ')}`;
}

export function CredentialDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  const createCredential = useCreateWeldPassCredential(projectId);

  const [provider, setProvider] = useState<WeldPassProviderId>('cloudflare_workers');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const isCloudflare = provider !== 'vercel';

  async function submit() {
    setFailure(null);
    try {
      await createCredential.mutateAsync({
        provider,
        name: name.trim(),
        token: token.trim(),
        metadata: isCloudflare
          ? { accountId: accountId.trim() || undefined }
          : { teamId: teamId.trim() || undefined },
      });
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldpass.syncPage.tokenForm.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('weldpass.syncPage.tokenForm.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label>{t('weldpass.syncPage.tokenForm.provider')}</Label>
            <Select
              value={provider}
              onValueChange={(next) => setProvider(next as WeldPassProviderId)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_IDS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {t(`weldpass.providers.${id}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="weldpass-token-name">
              {t('weldpass.syncPage.tokenForm.name')}
            </Label>
            <Input
              id="weldpass-token-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('weldpass.syncPage.tokenForm.nameHint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="weldpass-token-value">
              {t('weldpass.syncPage.tokenForm.token')}
            </Label>
            <Input
              id="weldpass-token-value"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('weldpass.syncPage.tokenForm.tokenHint')}
            </p>
          </div>

          {isCloudflare ? (
            <div className="space-y-1.5">
              <Label htmlFor="weldpass-account-id">
                {t('weldpass.syncPage.tokenForm.accountId')}
              </Label>
              <Input
                id="weldpass-account-id"
                className="font-mono"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('weldpass.syncPage.tokenForm.accountIdHint')}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="weldpass-team-id">
                {t('weldpass.syncPage.tokenForm.teamId')}
              </Label>
              <Input
                id="weldpass-team-id"
                className="font-mono"
                value={teamId}
                onChange={(event) => setTeamId(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('weldpass.syncPage.tokenForm.teamIdHint')}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('weldpass.secrets.form.cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!name.trim() || !token.trim() || createCredential.isPending}
          >
            {t('weldpass.syncPage.tokenForm.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TargetDialog({
  projectId,
  environments,
  credentials,
  onClose,
}: {
  projectId: string;
  environments: WeldPassEnvironment[];
  credentials: WeldPassCredential[];
  onClose: () => void;
}) {
  const t = useTranslations();
  const createTarget = useCreateWeldPassSyncTarget(projectId);

  const [credentialId, setCredentialId] = useState(credentials[0]?.id ?? '');
  const [environmentId, setEnvironmentId] = useState(environments[0]?.id ?? '');
  const [name, setName] = useState('');
  const [scriptName, setScriptName] = useState('');
  const [pagesProject, setPagesProject] = useState('');
  const [pagesEnvironment, setPagesEnvironment] = useState<'production' | 'preview'>('production');
  const [vercelProject, setVercelProject] = useState('');
  const [vercelTargets, setVercelTargets] = useState<
    Array<'production' | 'preview' | 'development'>
  >(['production']);
  const [autoSync, setAutoSync] = useState(false);
  const [prune, setPrune] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const credential = credentials.find((c) => c.id === credentialId);
  const provider = credential?.provider ?? 'cloudflare_workers';

  function buildConfig(): WeldPassSyncTargetConfig | null {
    if (!credential) return null;
    const accountId = credential.metadata.accountId ?? '';

    if (provider === 'cloudflare_workers') {
      if (!accountId || !scriptName.trim()) return null;
      return { provider, accountId, scriptName: scriptName.trim() };
    }
    if (provider === 'cloudflare_pages') {
      if (!accountId || !pagesProject.trim()) return null;
      return {
        provider,
        accountId,
        projectName: pagesProject.trim(),
        environment: pagesEnvironment,
      };
    }
    if (!vercelProject.trim() || vercelTargets.length === 0) return null;
    return {
      provider: 'vercel',
      projectId: vercelProject.trim(),
      teamId: credential.metadata.teamId,
      targets: vercelTargets,
    };
  }

  async function submit() {
    const config = buildConfig();
    if (!config) {
      setFailure(t('weldpass.syncPage.targetForm.incomplete'));
      return;
    }

    setFailure(null);
    try {
      await createTarget.mutateAsync({
        environmentId,
        credentialId,
        name: name.trim() || describeConfig(config),
        config,
        autoSync,
        prune,
      });
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldpass.syncPage.targetForm.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('weldpass.syncPage.targetForm.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label>{t('weldpass.syncPage.targetForm.credential')}</Label>
            <Select value={credentialId} onValueChange={setCredentialId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {credentials.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} · {t(`weldpass.providers.${c.provider}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t('weldpass.syncPage.targetForm.environment')}</Label>
            <Select value={environmentId} onValueChange={setEnvironmentId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {environments.map((environment) => (
                  <SelectItem key={environment.id} value={environment.id}>
                    {environment.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {provider === 'cloudflare_workers' && (
            <div className="space-y-1.5">
              <Label htmlFor="weldpass-script-name">
                {t('weldpass.syncPage.targetForm.scriptName')}
              </Label>
              <Input
                id="weldpass-script-name"
                className="font-mono"
                value={scriptName}
                onChange={(event) => setScriptName(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('weldpass.syncPage.targetForm.scriptNameHint')}
              </p>
            </div>
          )}

          {provider === 'cloudflare_pages' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="weldpass-pages-project">
                  {t('weldpass.syncPage.targetForm.pagesProject')}
                </Label>
                <Input
                  id="weldpass-pages-project"
                  className="font-mono"
                  value={pagesProject}
                  onChange={(event) => setPagesProject(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('weldpass.syncPage.targetForm.pagesEnvironment')}</Label>
                <Select
                  value={pagesEnvironment}
                  onValueChange={(next) =>
                    setPagesEnvironment(next as 'production' | 'preview')
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="production">production</SelectItem>
                    <SelectItem value="preview">preview</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t('weldpass.syncPage.targetForm.pagesEnvironmentHint')}
                </p>
              </div>
            </>
          )}

          {provider === 'vercel' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="weldpass-vercel-project">
                  {t('weldpass.syncPage.targetForm.vercelProject')}
                </Label>
                <Input
                  id="weldpass-vercel-project"
                  className="font-mono"
                  value={vercelProject}
                  onChange={(event) => setVercelProject(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t('weldpass.syncPage.targetForm.vercelProjectHint')}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>{t('weldpass.syncPage.targetForm.vercelTargets')}</Label>
                <div className="flex gap-4 text-xs">
                  {(['production', 'preview', 'development'] as const).map((target) => (
                    <label key={target} className="flex items-center gap-1.5">
                      <Checkbox
                        checked={vercelTargets.includes(target)}
                        onCheckedChange={(checked) =>
                          setVercelTargets((current) =>
                            checked === true
                              ? [...current, target]
                              : current.filter((entry) => entry !== target),
                          )
                        }
                      />
                      {target}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="weldpass-target-name">
              {t('weldpass.syncPage.targetForm.name')}
            </Label>
            <Input
              id="weldpass-target-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('weldpass.syncPage.targetForm.nameHint')}
            </p>
          </div>

          <div className="space-y-2 text-xs">
            <label className="flex items-start gap-2">
              <Checkbox
                checked={autoSync}
                onCheckedChange={(checked) => setAutoSync(checked === true)}
                className="mt-0.5"
              />
              <span>{t('weldpass.syncPage.targetForm.autoSync')}</span>
            </label>
            <label className="flex items-start gap-2">
              <Checkbox
                checked={prune}
                onCheckedChange={(checked) => setPrune(checked === true)}
                className="mt-0.5"
              />
              <span>{t('weldpass.syncPage.targetForm.prune')}</span>
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('weldpass.secrets.form.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={createTarget.isPending}>
            {t('weldpass.syncPage.targetForm.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
