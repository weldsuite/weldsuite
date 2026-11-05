import type { BreadcrumbSegment } from '@/components/breadcrumb-header';

// The generic "capitalize the first letter" fallback below can't know about
// the weld* family's internal capitalization (WeldCRM, not Weldcrm). Override
// just the path segments that need it; everything else keeps the generic
// behavior.
const BREADCRUMB_LABEL_OVERRIDES: Record<string, string> = {
  weldcrm: 'WeldCRM',
  welddesk: 'WeldDesk',
  weldmail: 'WeldMail',
  weldflow: 'WeldFlow',
  weldconnect: 'WeldConnect',
  weldstash: 'WeldStash',
  weldhost: 'WeldHost',
  weldhr: 'WeldHR',
  weldbooks: 'WeldBooks',
  weldmeet: 'WeldMeet',
  weldchat: 'WeldChat',
  weldagent: 'WeldAgent',
  weldapps: 'WeldApps',
  weldpass: 'WeldPass',
  weldreach: 'WeldReach',
  weldsheets: 'WeldSheets',
  welddocs: 'WeldDocs',
  weldboard: 'WeldBoard',
  weldsign: 'WeldSign',
  weldpanel: 'WeldPanel',
  weldsuite: 'WeldSuite',
  weldcommerce: 'WeldCommerce',
  weldsocial: 'WeldSocial',
  weldcalendar: 'WeldCalendar',
};

// The translated `t.settings.menu` titles the breadcrumbs reuse.
export interface BreadcrumbMenuLabels {
  profile: string;
  appearance: string;
  notifications: string;
  shortcuts: string;
  security: string;
  privacy: string;
  teamMembers: string;
  plans: string;
  billing: string;
  businessSettings: string;
  apiKeys: string;
  webhooks: string;
  sso: string;
  customFields: string;
  objectTemplates: string;
  integrations: string;
  phoneNumbers: string;
  entities: string;
  newEntity: string;
  editEntity: string;
  invoiceTemplates: string;
  editInvoiceTemplate: string;
  activityLog: string;
  dataExport: string;
  advanced: string;
  apps: string;
}

// URL segment -> translated sidebar title, so the breadcrumb says what the
// sidebar says ("API Keys", not "Api keys"; "general" is the legacy alias of
// the business settings page).
function getSegmentLabels(menu: BreadcrumbMenuLabels): Record<string, string> {
  return {
    appearance: menu.appearance,
    notifications: menu.notifications,
    shortcuts: menu.shortcuts,
    security: menu.security,
    privacy: menu.privacy,
    team: menu.teamMembers,
    plans: menu.plans,
    billing: menu.billing,
    business: menu.businessSettings,
    general: menu.businessSettings,
    'api-keys': menu.apiKeys,
    webhooks: menu.webhooks,
    sso: menu.sso,
    'custom-fields': menu.customFields,
    'object-templates': menu.objectTemplates,
    integrations: menu.integrations,
    'phone-numbers': menu.phoneNumbers,
    entities: menu.entities,
    activity: menu.activityLog,
    export: menu.dataExport,
    advanced: menu.advanced,
    apps: menu.apps,
  };
}

// An entity's invoice templates: Entities > Edit entity > Invoice templates
// (> Edit template). The entity and template ids add nothing to the trail.
function invoiceTemplateSegments(pathParts: string[], menu: BreadcrumbMenuLabels): BreadcrumbSegment[] | null {
  const [, area, entityId, section, templateId] = pathParts;
  if (area !== 'entities' || section !== 'invoice-templates') return null;
  const entityPath = `/settings/entities/${entityId}`;
  const trail: BreadcrumbSegment[] = [
    { label: menu.entities, href: '/settings/entities' },
    { label: menu.editEntity, href: `${entityPath}/edit` },
  ];
  if (!templateId) return [...trail, { label: menu.invoiceTemplates }];
  return [
    ...trail,
    { label: menu.invoiceTemplates, href: `${entityPath}/invoice-templates` },
    { label: menu.editInvoiceTemplate },
  ];
}

// Whether path segment `i` is an id that adds nothing to the trail.
function isIdSegment(pathParts: string[], i: number): boolean {
  // An entity's: Settings > Entities > Edit entity.
  if (pathParts[1] === 'entities') return i === 2 && pathParts[3] === 'edit';
  // A chat widget's: Settings > Apps > WeldDesk > Chat widget.
  return pathParts[2] === 'welddesk' && pathParts[3] === 'chat-widget' && i === 4;
}

// Label for path segment `i`: the app's own page title, else (under Entities)
// New/Edit entity, else a translated menu title, else a known module slug with
// its own internal capitalization, else the raw segment capitalized and
// spaced out.
function segmentLabel(
  pathParts: string[],
  i: number,
  menu: BreadcrumbMenuLabels,
  pageLabels: Record<string, string>,
): string {
  const part = pathParts[i];
  const key = part.toLowerCase();
  const underEntities = pathParts[1] === 'entities';
  const entityLabels: Record<string, string> = underEntities ? { add: menu.newEntity, edit: menu.editEntity } : {};
  return (
    pageLabels['/' + pathParts.slice(0, i + 1).join('/')] ??
    entityLabels[key] ??
    getSegmentLabels(menu)[key] ??
    BREADCRUMB_LABEL_OVERRIDES[key] ??
    part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ')
  );
}

// Build breadcrumb segments from the current path. The last segment is a leaf
// (no href); the /settings index page is the profile editor, shown as a leaf.
// `pageLabels` names an app's own settings pages by path
// ('/settings/apps/welddesk/email'), where the bare slug would read like a
// workspace page ("Email").
export function buildBreadcrumbSegments(
  pathname: string,
  settingsTitle: string,
  menu: BreadcrumbMenuLabels,
  pageLabels: Record<string, string> = {},
): BreadcrumbSegment[] {
  const segments: BreadcrumbSegment[] = [{ label: settingsTitle, href: '/settings' }];
  const pathParts = pathname.split('/').filter(Boolean);

  if (pathParts.length <= 1) {
    segments.push({ label: menu.profile });
    return segments;
  }

  const templateTrail = invoiceTemplateSegments(pathParts, menu);
  if (templateTrail) return [...segments, ...templateTrail];

  for (let i = 1; i < pathParts.length; i++) {
    if (isIdSegment(pathParts, i)) continue;
    const label = segmentLabel(pathParts, i, menu, pageLabels);
    if (i === pathParts.length - 1) {
      segments.push({ label });
    } else {
      segments.push({ label, href: '/' + pathParts.slice(0, i + 1).join('/') });
    }
  }
  return segments;
}
