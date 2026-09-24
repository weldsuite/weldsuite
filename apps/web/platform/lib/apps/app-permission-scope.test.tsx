import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppPermissionScope, PermissionProvider, usePermissions } from '@weldsuite/permissions/react';
import { getAppPermissionObjects } from './app-permission-objects';

function Probe() {
  const { can, hasAnyObject, appEnforced } = usePermissions();
  return (
    <span data-testid="probe">
      {JSON.stringify({
        read: can('companies:read'),
        crmDoor: hasAnyObject(getAppPermissionObjects('weldcrm'), 'weldcrm'),
        deskDoor: hasAnyObject(getAppPermissionObjects('welddesk'), 'welddesk'),
        appEnforced,
      })}
    </span>
  );
}

function probe(): Record<string, boolean> {
  return JSON.parse(screen.getByTestId('probe').textContent ?? '{}');
}

const CRM_ONLY = ['weldcrm:companies:read'];

describe('PermissionProvider app enforcement', () => {
  it('checks the current app once the server enforces per-app permissions', () => {
    render(
      <PermissionProvider permissions={CRM_ONLY} app="welddesk" enforceApp>
        <Probe />
      </PermissionProvider>,
    );
    expect(probe()).toMatchObject({ read: false, crmDoor: true, deskDoor: false, appEnforced: true });
  });

  it('checks any app while the server is still in log-only mode', () => {
    render(
      <PermissionProvider permissions={CRM_ONLY} app="welddesk" enforceApp={false}>
        <Probe />
      </PermissionProvider>,
    );
    // Same answer as the API gives in log mode: allowed because WeldCRM grants it.
    expect(probe()).toMatchObject({ read: true, deskDoor: true, appEnforced: false });
  });

  it('lets a subtree be evaluated against another app, keeping the mode', () => {
    render(
      <PermissionProvider permissions={CRM_ONLY} app="welddesk" enforceApp>
        <AppPermissionScope app="crm">
          <Probe />
        </AppPermissionScope>
      </PermissionProvider>,
    );
    expect(probe()).toMatchObject({ read: true, appEnforced: true });
  });
});

describe('getAppPermissionObjects', () => {
  it('opens an app for any object the per-app registry lists for it', () => {
    // companies/people are granted per app in the role editor, so a grant on
    // them alone has to open WeldCRM — they aren't in the legacy map.
    expect(getAppPermissionObjects('weldcrm')).toEqual(expect.arrayContaining(['leads', 'companies', 'people']));
  });

  it('resolves platform route codes and keeps post-refactor entries', () => {
    expect(getAppPermissionObjects('social')).toEqual(expect.arrayContaining(['posts', 'accounts']));
    expect(getAppPermissionObjects('weldpass')).toEqual(['secrets']);
    expect(getAppPermissionObjects('unknown-app')).toEqual([]);
  });
});
