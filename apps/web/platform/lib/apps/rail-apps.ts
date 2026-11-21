import type { InstalledApp } from '@/lib/api/apps';

/**
 * WeldAgent isn't an installed app (every workspace has it when the edition
 * offers the agent module), but it sits in the rail's app list like one so it
 * can be dragged between the other apps and keeps its slot in the saved order.
 */
export const WELDAGENT_RAIL_CODE = 'weldagent';

/** Path an app's rail icon links to: WeldApps (`appType: 'user'`) are hosted
 * at `/apps/{code}`, WeldObjects at `/objects/{code}`, first-party system apps
 * keep their own `/{code}` top-level route, and WeldAgent lives at `/agents`. */
export function railAppHref(appCode: string, appType?: 'system' | 'user' | 'object'): string {
  if (appCode === WELDAGENT_RAIL_CODE) return '/agents';
  if (appType === 'user') return `/apps/${appCode}`;
  // WeldObjects are first-party UI over user-defined schema, so they get a real
  // platform route rather than the sandboxed /apps/ iframe host.
  if (appType === 'object') return `/objects/${appCode}`;
  return `/${appCode}`;
}

/**
 * The installed apps plus WeldAgent when the edition offers it. WeldAgent goes
 * last until the user drags it elsewhere; the saved rail order does the rest.
 */
export function withAgentRailApp(
  installedApps: InstalledApp[],
  agent: { offered: boolean; name: string },
): InstalledApp[] {
  if (!agent.offered || installedApps.some((a) => a.appCode === WELDAGENT_RAIL_CODE)) {
    return installedApps;
  }
  return [
    ...installedApps,
    {
      id: WELDAGENT_RAIL_CODE,
      workspaceId: '',
      appCode: WELDAGENT_RAIL_CODE,
      name: agent.name,
      status: 'active',
      installedAt: '',
      displayOrder: installedApps.length,
      appType: 'system',
    },
  ];
}
