/** Builders for the WeldPanel tests: a project and its install check as the API returns them. */

import type { PanelInstallInfo, PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';

export function makeProject(overrides: Partial<PanelProjectDto> = {}): PanelProjectDto {
  return {
    id: 'wpp_1',
    name: 'Marketing site',
    kind: 'website',
    status: 'active',
    token: 'wpk_abc123',
    allowedDomains: ['example.com'],
    settings: {
      autocapture: true,
      maskingLevel: 'balanced',
      consentMode: 'required',
      recordingSampleRate: 1,
      excludedUrls: ['/admin/*'],
      ipFilters: [],
      aiEnabled: true,
    },
    createdByUserId: 'user_1',
    createdAt: '2026-10-20T09:00:00.000Z',
    updatedAt: '2026-10-21T09:00:00.000Z',
    ...overrides,
  };
}

export function makeInstall(overrides: Partial<PanelInstallInfo> = {}): PanelInstallInfo {
  const token = overrides.token ?? 'wpk_abc123';
  return {
    projectId: 'wpp_1',
    token,
    collectorUrl: 'https://pnl.weldsuite.org',
    scriptSnippet: `<script async src="https://pnl.weldsuite.org/s.js" data-project="${token}"></script>`,
    npmSnippet: `npm install @weldsuite/panel-sdk\n\nimport { init } from '@weldsuite/panel-sdk';\ninit('${token}');`,
    lastEventAt: null,
    status: 'waiting',
    ...overrides,
  };
}
