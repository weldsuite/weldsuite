/**
 * Data: the definitions that shape the project's reports. Custom events
 * (several events under one name), computed properties (values worked out
 * from event properties), path cleaning (rules that group page paths) and
 * group types. Reading needs `panel_reports:read`; changing them the report
 * create/update/delete permissions.
 */

import { useState } from 'react';
import { useCan } from '@weldsuite/permissions/react';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useI18n } from '@/lib/i18n/provider';
import { useSearchParams } from '@/lib/router';
import { AnalyticsPage } from '../components/analytics-page';
import { ComputedPropertiesTab } from './computed-properties-tab';
import { CustomEventsTab } from './custom-events-tab';
import { GroupTypesTab } from './group-types-tab';
import { PathRulesTab } from './path-rules-tab';

const TABS = ['customEvents', 'computedProperties', 'pathRules', 'groupTypes'] as const;
type DataTab = (typeof TABS)[number];

export default function DataPage() {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.data;
  const params = useSearchParams();
  const requested = params.get('tab');
  const [tab, setTab] = useState<DataTab>((TABS as readonly string[]).includes(requested ?? '') ? (requested as DataTab) : 'customEvents');
  const canCreate = useCan('panel_reports:create');
  const canUpdate = useCan('panel_reports:update');
  const canDelete = useCan('panel_reports:delete');
  const permissions = { canCreate, canUpdate, canDelete };

  return (
    <AnalyticsPage title={tx.title} description={tx.description}>
      {(project) => (
        <div key={project.id} className="grid gap-4">
          {!canCreate && !canUpdate && !canDelete && <InfoBanner variant="info">{tx.readOnly}</InfoBanner>}
          <Tabs value={tab} onValueChange={(next) => setTab(next as DataTab)} className="gap-4">
            <TabsList className="max-w-full overflow-x-auto">
              {TABS.map((key) => (
                <TabsTrigger key={key} value={key}>
                  {tx.tabs[key]}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="customEvents">
              <CustomEventsTab projectId={project.id} {...permissions} />
            </TabsContent>
            <TabsContent value="computedProperties">
              <ComputedPropertiesTab projectId={project.id} {...permissions} />
            </TabsContent>
            <TabsContent value="pathRules">
              <PathRulesTab projectId={project.id} canChange={canUpdate} />
            </TabsContent>
            <TabsContent value="groupTypes">
              <GroupTypesTab projectId={project.id} {...permissions} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </AnalyticsPage>
  );
}
