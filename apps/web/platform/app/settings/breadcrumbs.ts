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
  weldbooks: 'WeldBooks',
  weldmeet: 'WeldMeet',
  weldchat: 'WeldChat',
  weldagent: 'WeldAgent',
  weldapps: 'WeldApps',
  weldpass: 'WeldPass',
  weldsuite: 'WeldSuite',
  weldcommerce: 'WeldCommerce',
  weldsocial: 'WeldSocial',
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
  customFields: string;
  objectTemplates: string;
  integrations: string;
  phoneNumbers: string;
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
    'custom-fields': menu.customFields,
    'object-templates': menu.objectTemplates,
    integrations: menu.integrations,
    'phone-numbers': menu.phoneNumbers,
    activity: menu.activityLog,
    export: menu.dataExport,
    advanced: menu.advanced,
    apps: menu.apps,
  };
}

// Build breadcrumb segments from the current path. The last segment is a leaf
// (no href); the /settings index page is the profile editor, shown as a leaf.
export function buildBreadcrumbSegments(
  pathname: string,
  settingsTitle: string,
  menu: BreadcrumbMenuLabels,
): BreadcrumbSegment[] {
  const segments: BreadcrumbSegment[] = [{ label: settingsTitle, href: '/settings' }];
  const pathParts = pathname.split('/').filter(Boolean);

  if (pathParts.length <= 1) {
    segments.push({ label: menu.profile });
    return segments;
  }

  const segmentLabels = getSegmentLabels(menu);

  for (let i = 1; i < pathParts.length; i++) {
    const part = pathParts[i];
    const key = part.toLowerCase();
    // Translated menu title, else a known module slug with its own internal
    // capitalization, else capitalize and space out the raw segment.
    const label =
      segmentLabels[key] ??
      BREADCRUMB_LABEL_OVERRIDES[key] ??
      part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');
    if (i === pathParts.length - 1) {
      segments.push({ label });
    } else {
      segments.push({ label, href: '/' + pathParts.slice(0, i + 1).join('/') });
    }
  }
  return segments;
}
