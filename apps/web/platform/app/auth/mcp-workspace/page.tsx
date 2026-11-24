import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Building2, Clock } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Label } from '@weldsuite/ui/components/label';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import type { DecideMcpWorkspaceSelectionInput } from '@weldsuite/app-api-client/schemas/mcp-workspace-selections';
import { redirectToSignIn, useAuth, usesHostedSignIn } from '@/lib/auth';
import { getTranslations } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';
import {
  isExpiredSelection,
  useDecideMcpWorkspaceSelection,
  useMcpWorkspaceSelection,
} from '@/hooks/queries/use-mcp-workspace-selection-queries';

/**
 * The workspace step of connecting an AI app (an MCP client such as Claude)
 * on the EU and self-hosted editions. WeldID knows people, not workspaces, so
 * after its consent screen it sends the browser here with a one-time
 * `challenge`. The person picks the workspace the connection is for; the
 * answer goes back to WeldID, which returns the browser to the app, and the
 * connection's tokens then name that workspace (checked against the
 * memberships on every request).
 *
 * A workspace the app's MCP address names, or the person's only workspace,
 * is chosen without asking. Outside a workspace: the shell renders `/auth/*`
 * bare and activates no organization here.
 */
export default function McpWorkspacePage() {
  const t = getTranslations('common');
  const labels = t.auth.mcpWorkspace;
  const { isLoaded, isSignedIn } = useAuth();
  const challenge = useMemo(() => new URLSearchParams(window.location.search).get('challenge') ?? '', []);

  useEffect(() => {
    if (!isLoaded || isSignedIn || !challenge) return;
    // Signed in at the identity provider already (it just showed its consent
    // screen), so this comes straight back with a session.
    const here = window.location.pathname + window.location.search;
    if (usesHostedSignIn()) {
      void redirectToSignIn({ returnTo: here });
    } else {
      window.location.replace(`/auth/login?callbackUrl=${encodeURIComponent(here)}`);
    }
  }, [isLoaded, isSignedIn, challenge]);

  if (!challenge) {
    return (
      <Frame>
        <EmptyState icon={Clock} title={labels.expiredTitle} description={labels.expiredBody} />
      </Frame>
    );
  }
  if (!isLoaded || !isSignedIn) return <PageLoader label={labels.loading} />;
  return <WorkspaceChooser challenge={challenge} />;
}

function Frame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

function WorkspaceChooser({ challenge }: Readonly<{ challenge: string }>) {
  const t = getTranslations('common');
  const labels = t.auth.mcpWorkspace;
  const { format } = useI18n();
  const selection = useMcpWorkspaceSelection(challenge);
  const { mutate, isPending, error: decideError } = useDecideMcpWorkspaceSelection(challenge);
  const [chosen, setChosen] = useState('');
  const [missingChoice, setMissingChoice] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const autoContinued = useRef(false);
  const headingId = useId();
  const errorId = useId();
  const groupRef = useRef<HTMLDivElement>(null);

  const send = useCallback(
    (input: DecideMcpWorkspaceSelectionInput) => {
      mutate(input, {
        onSuccess: (res) => {
          // Back to the identity provider, which sends the browser on to the app.
          setLeaving(true);
          window.location.assign(res.data.redirectTo);
        },
      });
    },
    [mutate],
  );

  // Nothing to ask: the app named the workspace, or there is only one.
  const suggested = selection.data?.suggestedWorkspaceId ?? null;
  useEffect(() => {
    if (!suggested || autoContinued.current) return;
    autoContinued.current = true;
    send({ workspaceId: suggested });
  }, [suggested, send]);

  const failure = selection.error ?? decideError;
  if (failure) {
    return (
      <Frame>
        {isExpiredSelection(failure) ? (
          <EmptyState icon={Clock} title={labels.expiredTitle} description={labels.expiredBody} />
        ) : (
          <div className="space-y-3 text-center">
            <h1 className="text-xl font-semibold text-foreground">{labels.errorTitle}</h1>
            <ErrorState
              message={labels.errorBody}
              onRetry={() => window.location.reload()}
              retryLabel={labels.tryAgain}
            />
          </div>
        )}
      </Frame>
    );
  }

  const data = selection.data;
  if (!data) return <PageLoader label={labels.loading} />;
  if (leaving || isPending || suggested) return <PageLoader label={labels.continuing} />;

  if (data.workspaces.length === 0) {
    return (
      <Frame>
        <EmptyState
          icon={Building2}
          title={labels.noWorkspacesTitle}
          description={labels.noWorkspacesBody}
          action={
            <Button type="button" variant="outline" onClick={() => send({ decision: 'deny' })}>
              {labels.cancel}
            </Button>
          }
        />
      </Frame>
    );
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chosen) {
      setMissingChoice(true);
      groupRef.current?.querySelector<HTMLElement>('[role="radio"]')?.focus();
      return;
    }
    send({ workspaceId: chosen });
  };

  return (
    <Frame>
      <form onSubmit={onSubmit} aria-labelledby={headingId} className="space-y-6" noValidate>
        <div className="space-y-2 text-center">
          <h1 id={headingId} className="text-xl font-semibold text-foreground">
            {labels.title}
          </h1>
          <p className="text-sm text-muted-foreground">{format(labels.subtitle, { client: data.client.name })}</p>
          {data.client.host && (
            <p className="text-xs text-muted-foreground">{format(labels.returnsTo, { host: data.client.host })}</p>
          )}
        </div>

        <fieldset className="space-y-2">
          <legend className="sr-only">{labels.title}</legend>
          <RadioGroup
            ref={groupRef}
            name="workspaceId"
            value={chosen}
            onValueChange={(value) => {
              setChosen(value);
              setMissingChoice(false);
            }}
            aria-invalid={missingChoice || undefined}
            aria-describedby={missingChoice ? errorId : undefined}
            className="max-h-80 gap-2 overflow-y-auto"
          >
            {data.workspaces.map((workspace) => {
              const id = `${headingId}-${workspace.id}`;
              return (
                <Label
                  key={workspace.id}
                  htmlFor={id}
                  className="flex min-h-12 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent"
                >
                  <RadioGroupItem id={id} value={workspace.id} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{workspace.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{workspace.slug}</span>
                  </span>
                </Label>
              );
            })}
          </RadioGroup>
          {missingChoice && (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {labels.required}
            </p>
          )}
        </fieldset>

        <p className="text-xs text-muted-foreground">{labels.hint}</p>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => send({ decision: 'deny' })}>
            {labels.cancel}
          </Button>
          <Button type="submit">{labels.continue}</Button>
        </div>
      </form>
    </Frame>
  );
}
