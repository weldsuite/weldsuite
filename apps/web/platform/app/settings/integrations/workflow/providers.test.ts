import { describe, expect, it } from 'vitest';
import { WELDCONNECT_ACTION_TYPES } from '@/app/weldconnect/mvp';
import { LISTED_WORKFLOW_PROVIDERS, WORKFLOW_PROVIDERS, workflowProviderSettingsPath } from './providers';

describe('workflow providers on Settings → Integrations', () => {
  it('lists exactly the providers whose steps the workflow editor offers', () => {
    // `merge.*` steps are WeldMerge's own, not a connected provider's.
    const providers = new Set(WORKFLOW_PROVIDERS.map((provider) => provider.type));
    const inEditor = new Set(
      WELDCONNECT_ACTION_TYPES.map((type) => type.split('.')[0]).filter((prefix) => providers.has(prefix)),
    );
    expect(new Set(LISTED_WORKFLOW_PROVIDERS.map((provider) => provider.type))).toEqual(inEditor);
  });

  it('sends each provider to its own Settings page', () => {
    expect(workflowProviderSettingsPath('slack')).toBe('/settings/integrations/slack');
    expect(workflowProviderSettingsPath('google_sheets')).toBe('/settings/integrations/google-sheets');
    expect(workflowProviderSettingsPath('google_calendar')).toBe('/settings/integrations/google-calendar');
    expect(workflowProviderSettingsPath('unknown')).toBe('/settings/integrations');
    expect(new Set(WORKFLOW_PROVIDERS.map((provider) => provider.slug)).size).toBe(WORKFLOW_PROVIDERS.length);
  });
});
