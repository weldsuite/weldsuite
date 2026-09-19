import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Copy, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { useDeveloperI18n } from '@/lib/i18n';
import { platformAppUrl, platformManageUrl } from '@/lib/public-env';
import { cn, formatBytes, formatDate } from '@/lib/utils';
import { useCanDevelopApps, useCanPublishApps } from '@/hooks/use-permissions';
import {
  useCreateUserAppOauthClient,
  useDeleteUserApp,
  useSubmitUserApp,
  useUpdateUserApp,
  useUserApp,
  useUserAppOauthClient,
  useUserAppVersions,
} from '@/hooks/use-user-apps';
import { AppLogoField } from '@/components/app-logo-field';

function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useDeveloperI18n();
  return (
    <div className="relative overflow-hidden rounded-lg bg-[var(--code-bg)] text-[var(--code-fg)]">
      <pre className="overflow-x-auto p-4 text-xs leading-relaxed">{children}</pre>
      <button
        type="button"
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] text-white/80 hover:bg-white/20"
        onClick={async () => {
          await navigator.clipboard.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? t.detail.copied : t.detail.copy}
      </button>
    </div>
  );
}

export function AppDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { t, format } = useDeveloperI18n();
  const { canDevelop, isLoading: permissionsLoading } = useCanDevelopApps();
  const canPublish = useCanPublishApps();

  const { data: app, isLoading } = useUserApp(id, !!id && canDevelop);
  const { data: versions, isLoading: versionsLoading } = useUserAppVersions(id, !!id && canDevelop);
  const { data: oauthClient } = useUserAppOauthClient(id, !!id && canDevelop);

  const updateMutation = useUpdateUserApp();
  const deleteMutation = useDeleteUserApp();
  const submitMutation = useSubmitUserApp();
  const oauthMutation = useCreateUserAppOauthClient();

  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [icon, setIcon] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [submitNotes, setSubmitNotes] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oauthSecret, setOauthSecret] = useState<{ clientId: string; clientSecret: string } | null>(
    null,
  );

  if (permissionsLoading || isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t.shell.loading}
      </div>
    );
  }

  if (!canDevelop || !app) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">{t.detail.notFound}</p>
        <Link to="/apps" className="mt-2 inline-block text-sm text-primary hover:underline">
          {t.detail.back}
        </Link>
      </div>
    );
  }

  const displayName = name ?? app.name;
  const displayDescription = description ?? app.description ?? '';
  const displayIcon = icon ?? app.icon ?? '';
  const displayCategory = category ?? app.category ?? '';

  const fieldClass =
    'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring';

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await updateMutation.mutateAsync({
        id: app.id,
        data: {
          name: displayName.trim(),
          description: displayDescription.trim() || undefined,
          icon: displayIcon.trim() || undefined,
          category: displayCategory.trim() || undefined,
        },
      });
      setMessage(t.detail.saveSuccess);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.detail.saveError);
    }
  };

  const onSubmitReview = async () => {
    setError(null);
    setMessage(null);
    try {
      await submitMutation.mutateAsync({ id: app.id, notes: submitNotes || undefined });
      setMessage(t.detail.submitSuccess);
      setSubmitNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t.detail.submitError);
    }
  };

  const onDelete = async () => {
    if (!window.confirm(format(t.detail.deleteConfirm, { name: app.name }))) return;
    try {
      await deleteMutation.mutateAsync(app.id);
      navigate('/apps');
    } catch (err) {
      setError(err instanceof Error ? err.message : t.detail.deleteError);
    }
  };

  const onOauth = async () => {
    setError(null);
    try {
      const created = await oauthMutation.mutateAsync(app.id);
      setOauthSecret(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.detail.saveError);
    }
  };

  const deploySnippet = [
    'export WELD_API_KEY=wsk_...',
    'cd your-app',
    '# bump version in weldapp.json',
    'weld app deploy --changelog "What changed"',
  ].join('\n');

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border px-6 py-5">
        <Link
          to="/apps"
          className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t.detail.back}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{app.name}</h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{app.code}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={platformAppUrl(app.code)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
            >
              <ExternalLink className="h-4 w-4" />
              {t.detail.openInPlatform}
            </a>
            <a
              href={platformManageUrl()}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
            >
              {t.detail.openManage}
            </a>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {format(t.detail.previewHint, { code: app.code })}
        </p>
      </header>

      <div className="flex-1 space-y-8 overflow-y-auto p-6">
        {(message || error) && (
          <p className={cn('text-sm', error ? 'text-destructive' : 'text-primary')}>
            {error ?? message}
          </p>
        )}

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t.detail.deployTitle}
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t.detail.deployIntro}</p>
          <CodeBlock>{deploySnippet}</CodeBlock>
          <p className="text-xs text-muted-foreground">
            <Link to="/getting-started" className="text-primary hover:underline">
              {t.nav.gettingStarted}
            </Link>
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t.detail.metadata}
          </h2>
          <form onSubmit={onSave} className="max-w-lg space-y-3">
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t.create.nameLabel}</span>
              <input
                className={fieldClass}
                value={displayName}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t.create.descriptionLabel}</span>
              <textarea
                className={fieldClass}
                rows={3}
                value={displayDescription}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t.create.categoryLabel}</span>
              <input
                className={fieldClass}
                value={displayCategory}
                onChange={(e) => setCategory(e.target.value)}
              />
            </label>
            <AppLogoField
              appId={app.id}
              value={displayIcon}
              onChange={async (next) => {
                setIcon(next);
                setError(null);
                setMessage(null);
                try {
                  await updateMutation.mutateAsync({
                    id: app.id,
                    data: { icon: next.trim() || 'Puzzle' },
                  });
                  setMessage(t.detail.saveSuccess);
                } catch (err) {
                  setError(err instanceof Error ? err.message : t.detail.saveError);
                }
              }}
              disabled={updateMutation.isPending}
            />
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>
                {app.visibility === 'public' ? t.apps.visibilityPublic : t.apps.visibilityPrivate}
              </span>
              <span>·</span>
              <span>
                {app.reviewStatus === 'draft'
                  ? t.apps.statusDraft
                  : app.reviewStatus === 'submitted'
                    ? t.apps.statusSubmitted
                    : app.reviewStatus === 'approved'
                      ? t.apps.statusApproved
                      : t.apps.statusRejected}
              </span>
              <span>·</span>
              <span>
                {t.apps.columnInstalls}: {app.installCount}
              </span>
            </div>
            {app.reviewNotes ? (
              <p className="rounded-md bg-muted px-3 py-2 text-xs">
                <span className="font-medium">{t.detail.reviewNotes}: </span>
                {app.reviewNotes}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={updateMutation.isPending}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t.detail.save}
            </button>
          </form>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t.detail.listingTitle}
          </h2>
          {app.websiteUrl || app.privacyUrl || (app.screenshots && app.screenshots.length > 0) ? (
            <ul className="space-y-1 text-sm text-muted-foreground">
              {app.websiteUrl ? (
                <li>
                  Website:{' '}
                  <a className="text-primary hover:underline" href={app.websiteUrl} target="_blank" rel="noreferrer">
                    {app.websiteUrl}
                  </a>
                </li>
              ) : null}
              {app.privacyUrl ? (
                <li>
                  Privacy:{' '}
                  <a className="text-primary hover:underline" href={app.privacyUrl} target="_blank" rel="noreferrer">
                    {app.privacyUrl}
                  </a>
                </li>
              ) : null}
              {app.screenshots?.length ? (
                <li>Screenshots: {app.screenshots.length}</li>
              ) : null}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t.detail.listingEmpty}</p>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t.detail.versions}
          </h2>
          {versionsLoading ? (
            <p className="text-sm text-muted-foreground">{t.shell.loading}</p>
          ) : !versions || versions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6">
              <p className="text-sm font-medium">{t.detail.versionsEmpty}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t.detail.versionsEmptyHint}</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t.detail.columnVersion}</th>
                    <th className="px-4 py-2 font-medium">{t.detail.columnStatus}</th>
                    <th className="px-4 py-2 font-medium">{t.detail.columnDate}</th>
                    <th className="px-4 py-2 font-medium">{t.detail.columnSize}</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={`${v.version}-${v.createdAt}`} className="border-t border-border">
                      <td className="px-4 py-2 font-mono text-xs">{v.version}</td>
                      <td className="px-4 py-2">{v.status}</td>
                      <td className="px-4 py-2 text-muted-foreground">{formatDate(v.createdAt)}</td>
                      <td className="px-4 py-2 text-muted-foreground">{formatBytes(v.bundleSize)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t.detail.oauthTitle}
          </h2>
          <p className="text-sm text-muted-foreground">{t.detail.oauthDescription}</p>
          {oauthClient?.clientId ? (
            <p className="font-mono text-xs">
              {t.detail.oauthClientId}: {oauthClient.clientId}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t.detail.oauthNone}</p>
          )}
          <button
            type="button"
            onClick={onOauth}
            disabled={oauthMutation.isPending}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-60"
          >
            {oauthMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {oauthClient?.clientId ? t.detail.oauthRotate : t.detail.oauthCreate}
          </button>
          {oauthSecret ? (
            <div className="rounded-lg border border-border bg-muted/40 p-4">
              <p className="text-sm font-medium">{t.detail.oauthSecretTitle}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t.detail.oauthSecretHint}</p>
              <p className="mt-3 font-mono text-xs break-all">{oauthSecret.clientSecret}</p>
              <button
                type="button"
                className="mt-3 text-sm text-primary hover:underline"
                onClick={() => setOauthSecret(null)}
              >
                {t.detail.oauthDone}
              </button>
            </div>
          ) : null}
        </section>

        {canPublish && app.reviewStatus !== 'submitted' && app.reviewStatus !== 'approved' ? (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t.detail.submitReview}
            </h2>
            <label className="block max-w-lg space-y-1">
              <span className="text-sm font-medium">{t.detail.submitNotesLabel}</span>
              <textarea
                className={fieldClass}
                rows={2}
                value={submitNotes}
                onChange={(e) => setSubmitNotes(e.target.value)}
                placeholder={t.detail.submitNotesPlaceholder}
              />
            </label>
            <button
              type="button"
              onClick={onSubmitReview}
              disabled={submitMutation.isPending}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {submitMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t.detail.submitReview}
            </button>
          </section>
        ) : null}

        <section className="border-t border-border pt-6">
          <button
            type="button"
            onClick={onDelete}
            disabled={deleteMutation.isPending}
            className="inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-60"
          >
            <Trash2 className="h-4 w-4" />
            {t.detail.deleteApp}
          </button>
        </section>
      </div>
    </div>
  );
}
