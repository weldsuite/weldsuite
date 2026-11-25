import { AlertCircle, CheckCircle2, FlaskConical, Loader2, Plug } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import type { IntegrationDef, WorkflowIntegration } from '@/hooks/queries/use-workflow-integration-queries';
import { useWorkflowConnection, type WorkflowConnection } from './use-workflow-connection';

function formatDate(value: string | null, language: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(language);
}

/** The live connection: connected or failing, since when, and a test. */
function ConnectionStatus({ connection, state }: Readonly<{ connection: WorkflowIntegration; state: WorkflowConnection }>) {
  const { t, format, language } = useI18n();
  const copy = t.settings.integrations.workflowConnections;
  const since = formatDate(connection.connectedAt, language);
  const failing = Boolean(connection.lastError);
  const StatusIcon = failing ? AlertCircle : CheckCircle2;
  const TestIcon = state.testing ? Loader2 : FlaskConical;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3">
      <p className="flex items-center gap-2 text-sm">
        <StatusIcon
          className={failing ? 'h-4 w-4 shrink-0 text-destructive' : 'h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400'}
          aria-hidden="true"
        />
        <span className="font-medium">{failing ? copy.error : copy.connected}</span>
        {since ? <span className="text-muted-foreground">{format(copy.connectedSince, { date: since })}</span> : null}
      </p>
      {state.canManage ? (
        <Button type="button" variant="outline" size="sm" onClick={state.test} disabled={state.testing}>
          <TestIcon className={state.testing ? 'mr-1.5 h-3.5 w-3.5 animate-spin' : 'mr-1.5 h-3.5 w-3.5'} />
          {copy.test}
        </Button>
      ) : null}
      {failing ? <p className="w-full text-sm text-destructive">{connection.lastError}</p> : null}
    </div>
  );
}

function CapabilityList({ heading, items }: Readonly<{ heading: string; items: ReadonlyArray<{ id: string; name: string }> }>) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">{heading}</h3>
      <ul className="space-y-1.5 text-sm text-muted-foreground">
        {items.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </div>
  );
}

/** What workflows can do with the provider: its catalog actions and triggers. */
function Capabilities({ def }: Readonly<{ def: IntegrationDef }>) {
  const { t } = useI18n();
  const copy = t.settings.integrations.workflowConnections;
  if (def.actions.length === 0 && def.triggers.length === 0) return null;
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <CapabilityList heading={copy.actionsHeading} items={def.actions} />
      <CapabilityList heading={copy.triggersHeading} items={def.triggers} />
    </div>
  );
}

/**
 * The live connection's state and test, and what workflows can do with the
 * provider (its catalog actions and triggers).
 */
export function WorkflowConnectionDetails({ state }: Readonly<{ state: WorkflowConnection }>) {
  return (
    <div className="space-y-6">
      {state.connection ? <ConnectionStatus connection={state.connection} state={state} /> : null}
      {state.def ? <Capabilities def={state.def} /> : null}
    </div>
  );
}

/** The section's one button: disconnect when connected, connect when not, nothing without the permission. */
function SectionAction({ state, connectLabel }: Readonly<{ state: WorkflowConnection; connectLabel: string }>) {
  const { t } = useI18n();
  const copy = t.settings.integrations.workflowConnections;

  if (state.isLoading) {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />;
  }
  if (state.connection) {
    if (!state.canManage) return null;
    return (
      <Button type="button" variant="outline" className="hover:text-destructive" onClick={state.disconnect} disabled={state.working}>
        {copy.disconnect}
      </Button>
    );
  }
  if (!state.canConnect) return null;
  const Icon = state.working ? Loader2 : Plug;
  return (
    <Button type="button" onClick={state.connect} disabled={state.working}>
      <Icon className={state.working ? 'mr-1.5 h-3.5 w-3.5 animate-spin' : 'mr-1.5 h-3.5 w-3.5'} />
      {connectLabel}
    </Button>
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
        <SectionAction state={state} connectLabel={connectLabel ?? copy.connect} />
      </div>
      <WorkflowConnectionDetails state={state} />
      {state.dialogs}
    </section>
  );
}
