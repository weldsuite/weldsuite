import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PermissionProvider, usePermissions } from '@weldsuite/permissions/react';

const env = vi.hoisted(() => ({
  access: { data: undefined as unknown, isLoading: false },
}));

vi.mock('@/hooks/queries/use-legal-entities-queries', () => ({
  useMyLegalEntityAccess: () => env.access,
}));

import { EntityPermissionScope } from './entity-permission-scope';

function Probe() {
  const { can } = usePermissions();
  return (
    <p>
      read:{String(can('invoices:read'))} delete:{String(can('invoices:delete'))}
    </p>
  );
}

function renderScope(entityId: string | null) {
  return render(
    <PermissionProvider permissions={['invoices:read', 'invoices:delete']} role="ADMIN" enforceApp={false}>
      <EntityPermissionScope entityId={entityId}>
        <Probe />
      </EntityPermissionScope>
    </PermissionProvider>,
  );
}

describe('EntityPermissionScope', () => {
  it('uses the permissions the member holds inside the entity', () => {
    env.access = { data: { permissions: ['invoices:read'], denies: [], isOwner: false }, isLoading: false };
    renderScope('ent_1');

    expect(screen.getByText('read:true delete:false')).toBeInTheDocument();
  });

  it('answers no while the entity access loads', () => {
    env.access = { data: undefined, isLoading: true };
    renderScope('ent_1');

    expect(screen.getByText('read:false delete:false')).toBeInTheDocument();
  });

  it('keeps the workspace permissions when the access cannot be loaded or there is no entity', () => {
    env.access = { data: undefined, isLoading: false };
    renderScope('ent_1');
    expect(screen.getByText('read:true delete:true')).toBeInTheDocument();
  });

  it('gives an entity owner everything', () => {
    env.access = { data: { permissions: [], denies: [], isOwner: true }, isLoading: false };
    renderScope('ent_1');

    expect(screen.getByText('read:true delete:true')).toBeInTheDocument();
  });
});
