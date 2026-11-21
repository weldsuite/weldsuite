/**
 * Data: the definitions that shape the project's reports, as the standard
 * list. One row per kind: custom events (several events under one name),
 * computed properties (values worked out from event properties), path
 * cleaning (rules that group page paths) and group types, each with what it
 * is and how many there are. A row opens that kind's own list in place
 * (`?tab=`), under the standard title row with a back arrow. Reading needs
 * `panel_reports:read`; changing them the report create/update/delete
 * permissions.
 */

import type { ComponentType } from 'react';
import { Building2, Layers, Route, Sigma } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { PANEL_MAX_GROUP_TYPES } from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { RecordingHeader } from '@weldsuite/ui/components/recording-layout';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import {
  useWeldPanelComputedProperties,
  useWeldPanelCustomEvents,
  useWeldPanelGroupTypes,
  useWeldPanelPathRules,
} from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter, useSearchParams } from '@/lib/router';
import { AnalyticsListPage } from '../components/analytics-page';
import { formatNumber } from '../lib/format';
import { ComputedPropertiesTab } from './computed-properties-tab';
import { CustomEventsTab } from './custom-events-tab';
import { GroupTypesTab } from './group-types-tab';
import { PathRulesTab } from './path-rules-tab';

const TABS = ['customEvents', 'computedProperties', 'pathRules', 'groupTypes'] as const;
type DataTab = (typeof TABS)[number];

const LIST_HREF = '/weldpanel/data';
const ICONS: Record<DataTab, ComponentType<{ className?: string }>> = {
  customEvents: Layers,
  computedProperties: Sigma,
  pathRules: Route,
  groupTypes: Building2,
};

/** The kind `?tab=` names, or null for the list of kinds. */
export function requestedTab(value: string | null): DataTab | null {
  return (TABS as readonly string[]).includes(value ?? '') ? (value as DataTab) : null;
}

interface KindRow {
  id: DataTab;
  label: string;
  description: string;
  count: number | undefined;
}

/** The four kinds as the standard list; a row opens that kind. */
function Kinds({ projectId }: Readonly<{ projectId: string }>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.data;
  const router = useRouter();
  const counts: Record<DataTab, number | undefined> = {
    customEvents: useWeldPanelCustomEvents(projectId).data?.length,
    computedProperties: useWeldPanelComputedProperties(projectId).data?.length,
    pathRules: useWeldPanelPathRules(projectId).data?.length,
    groupTypes: useWeldPanelGroupTypes(projectId).data?.length,
  };
  const descriptions: Record<DataTab, string> = {
    customEvents: tx.customEvents.description,
    computedProperties: tx.computedProperties.description,
    pathRules: tx.pathRules.description,
    groupTypes: format(tx.groupTypes.description, { count: PANEL_MAX_GROUP_TYPES }),
  };
  const rows: KindRow[] = TABS.map((id) => ({ id, label: tx.tabs[id], description: descriptions[id], count: counts[id] }));

  const columns: ColumnDef<KindRow>[] = [
    {
      id: 'name',
      header: tx.columns.name,
      width: 'w-[240px] shrink-0',
      render: (row) => {
        const Icon = ICONS[row.id];
        return (
          <span className="flex min-w-0 items-center gap-2.5">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{row.label}</span>
          </span>
        );
      },
    },
    {
      id: 'description',
      header: tx.columns.description,
      width: 'hidden md:block flex-1 min-w-0',
      render: (row) => <span className="block truncate text-muted-foreground">{row.description}</span>,
    },
    {
      id: 'count',
      header: tx.columns.count,
      width: 'w-[90px] text-right',
      headerClassName: 'text-right',
      render: (row) => <span className="tabular-nums">{row.count === undefined ? '–' : formatNumber(row.count, language)}</span>,
    },
  ];

  return (
    <PanelEntityList<KindRow>
      items={rows}
      isLoading={false}
      columns={columns}
      hideFilter
      searchPlaceholder={tx.search}
      searchFields={['label', 'description']}
      onRowClick={(row) => router.push(`${LIST_HREF}?tab=${row.id}`)}
      emptyState={{ title: tx.title, description: tx.description }}
      noResultsState={{ title: tx.noMatchTitle, description: tx.noMatchDescription }}
    />
  );
}

export default function DataPage() {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.data;
  const router = useRouter();
  const tab = requestedTab(useSearchParams().get('tab'));
  const canCreate = useCan('panel_reports:create');
  const canUpdate = useCan('panel_reports:update');
  const canDelete = useCan('panel_reports:delete');
  const permissions = { canCreate, canUpdate, canDelete };
  const readOnly = !canCreate && !canUpdate && !canDelete;

  return (
    <AnalyticsListPage title={tx.title}>
      {(project) =>
        tab === null ? (
          <div key={project.id}>
            {readOnly && (
              <div className="p-3 md:px-4">
                <InfoBanner variant="info">{tx.readOnly}</InfoBanner>
              </div>
            )}
            <Kinds projectId={project.id} />
          </div>
        ) : (
          <div key={project.id}>
            <RecordingHeader onBack={() => router.push(LIST_HREF)} backLabel={tx.back} title={tx.tabs[tab]} />
            {readOnly && (
              <div className="p-3 md:px-4">
                <InfoBanner variant="info">{tx.readOnly}</InfoBanner>
              </div>
            )}
            {tab === 'customEvents' && <CustomEventsTab projectId={project.id} {...permissions} />}
            {tab === 'computedProperties' && <ComputedPropertiesTab projectId={project.id} {...permissions} />}
            {tab === 'pathRules' && <PathRulesTab projectId={project.id} canChange={canUpdate} />}
            {tab === 'groupTypes' && <GroupTypesTab projectId={project.id} {...permissions} />}
          </div>
        )
      }
    </AnalyticsListPage>
  );
}
