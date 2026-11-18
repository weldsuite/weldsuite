/**
 * "API access" in the WeldPanel settings: how to read WeldPanel data from
 * outside, through the public API (`/v1/panel`, scope `panel:read`) and the
 * WeldSuite MCP server's `weldpanel_*` tools. Code and names are not
 * translated.
 */

import { KeyRound } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { publicEnv } from '@/lib/runtime-config';
import { CopyBlock } from '../components/copy-block';

/** The scope an API key needs (external-api `requireScope('panel:read')`). */
export const PANEL_API_SCOPE = 'panel:read';
/** The public API's WeldPanel routes on this deployment (as the API keys page shows the API's address). */
export function panelApiBaseUrl(): string {
  const origin = publicEnv('VITE_EXTERNAL_API_URL') ?? 'https://api.weldsuite.org';
  let end = origin.length;
  while (end > 0 && origin[end - 1] === '/') end -= 1;
  return `${origin.slice(0, end)}/v1/panel`;
}

export const MCP_SERVER_NAME = 'weldsuite';

/** The MCP tools that read WeldPanel data (apps/workers/mcp-server/src/tools/panel). */
export const PANEL_MCP_TOOLS = [
  'weldpanel_list_projects',
  'weldpanel_query',
  'weldpanel_list_reports',
  'weldpanel_get_report',
  'weldpanel_get_report_results',
  'weldpanel_list_dashboards',
  'weldpanel_get_dashboard',
  'weldpanel_list_cohorts',
  'weldpanel_list_events',
  'weldpanel_search_people',
  'weldpanel_get_person',
  'weldpanel_list_groups',
  'weldpanel_get_group',
] as const;

/** The external API's WeldPanel routes, under the base URL. */
export const PANEL_API_ENDPOINTS = [
  'GET  /projects',
  'POST /query',
  'GET  /reports',
  'GET  /reports/:id',
  'GET  /reports/:id/results',
  'GET  /dashboards',
  'GET  /dashboards/:id',
  'GET  /cohorts',
  'GET  /events',
  'GET  /people?search=',
  'GET  /people/:distinctId',
  'GET  /groups?type=',
  'GET  /groups/:type/:key',
] as const;

export function ApiAccessView() {
  const { t } = useI18n();
  const ta = t.weldpanel.collab.api;
  return (
    <SectionCard
      title={ta.title}
      description={ta.description}
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/settings/api-keys">
            <KeyRound />
            {ta.createKey}
          </Link>
        </Button>
      }
    >
      <div className="grid gap-5">
        <CopyBlock title={ta.baseUrlLabel} value={panelApiBaseUrl()} />
        <CopyBlock title={ta.scopeLabel} description={ta.scopeHint} value={PANEL_API_SCOPE} />
        <CopyBlock title={ta.endpointsTitle} value={PANEL_API_ENDPOINTS.join('\n')} />
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">{ta.mcpTitle}</h3>
          <p className="text-sm text-muted-foreground">{ta.mcpDescription}</p>
          <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted-foreground">{ta.mcpServerLabel}</dt>
            <dd className="font-mono">{MCP_SERVER_NAME}</dd>
            <dt className="text-muted-foreground">{ta.toolsLabel}</dt>
            <dd>
              <ul className="flex flex-wrap gap-1.5">
                {PANEL_MCP_TOOLS.map((tool) => (
                  <li key={tool}>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{tool}</code>
                  </li>
                ))}
              </ul>
            </dd>
          </dl>
        </div>
      </div>
    </SectionCard>
  );
}
