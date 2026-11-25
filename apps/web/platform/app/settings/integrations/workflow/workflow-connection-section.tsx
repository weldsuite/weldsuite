import { AlertCircle, CheckCircle2, FlaskConical, Loader2, Plug } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { useWorkflowConnection, type WorkflowConnection } from './use-workflow-connection';

function formatDate(value: string | null, language: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(language);
}

/**
 * The live connection's state and test, and what workflows can do with the
 * provider (its catalog actions and triggers).
 */
export function WorkflowConnectionDetails({ state }: Readonly<{ state: WorkflowConnection }>) {
  const { t, format, language } = useI18n();
  const copy = t.settings.integrations.workflowConnections;
  const { def, connection } = state;
  const since = formatDate(connection?.connectedAt ?? null, language);

  return (
    <div className="space-y-6">
      {connection ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3">
          <p className="flex items-center gap-2 text-sm">
            {connection.lastError ? (
              <AlertCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            )}
            <span className="font-medium">{connection.lastError ? copy.error : copy.connected}</span>
            {since ? <span className="text-muted-foreground">{format(copy.connectedSince, { date: since })}</span> : null}
          </p>
          {state.canManage ? (
            <Button type="button" variant="outline" size="sm" onClick={state.test} disabled={state.testing}>
              {state.testing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
              )}
              {copy.test}
            </Button>
          ) : null}
          {connection.lastError ? (
            <p className="w-full text-sm text-destructive">{connection.lastError}</p>
          ) : null}
        </div>
      ) : null}

      {def && (def.actions.length > 0 || def.triggers.length > 0) ? (
        <div className="grid gap-6 sm:grid-cols-2">
          {def.actions.length > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-medium">{copy.actionsHeading}</h3>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                {def.actions.map((action) => (
                  <li key={action.id}>{action.name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {def.triggers.length > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-medium">{copy.triggersHeading}</h3>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                {def.triggers.map((trigger) => (
                  <li key={trigger.id}>{trigger.name}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface WorkflowConnectionSectionProps {
  /** The catalog type (`slack`, `google_calendar`, `github`). */
  type: string;
  providerName: string;
  /** The connect button's label; "Connect" when left out. */
  connectLabel?: string;
}

/**
 * "Workflow actions" on a vendor's page that other uses share (Slack's
 * helpdesk channel, Google Calendar's sync, the GitHub App): the connection
 * WeldConnect workflows use, with its own connect and disconnect.
 */
export function WorkflowConnectionSection({ type, providerName, connectLabel }: Readonly<WorkflowConnectionSectionProps>) {
  const { t, format } = useI18n();
  const copy = t.settings.integrations.workflowConnections;
  const state = useWorkflowConnection(type, providerName);
  const connected = Boolean(state.connection);
  const headingId = `workflow-connection-${type}`;

  if (!state.isLoading && !state.def) return null;

  return (
    <section aria-labelledby={headingId} className="mt-10 space-y-4 border-t pt-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-xl font-semibold text-foreground">
            {copy.sectionTitle}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{format(copy.sectionDescription, { provider: providerName })}</p>
        </div>
        {state.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : connected ? (
          state.canManage ? (
            <Button type="button" variant="outline" className="hover:text-destructive" onClick={state.disconnect} disabled={state.working}>
              {copy.disconnect}
            </Button>
          ) : null
        ) : state.canConnect ? (
          <Button type="button" onClick={state.connect} disabled={state.working}>
            {state.working ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plug className="mr-1.5 h-3.5 w-3.5" />}
            {connectLabel ?? copy.connect}
          </Button>
        ) : null}
      </div>
      <WorkflowConnectionDetails state={state} />
      {state.dialogs}
    </section>
  );
}
