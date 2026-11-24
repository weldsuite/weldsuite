/**
 * The Access tab's lockout guards: only owners see every legal entity, so an
 * admin who restricts an entity without being listed, or takes themselves off
 * a restricted one, is asked first and then sent back to the list.
 */

import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { LegalEntity, LegalEntityAccess, LegalEntityAccessMember } from '@weldsuite/app-api-client/schemas/legal-entities';

const m = vi.hoisted(() => ({
  userId: 'u_admin' as string | null,
  access: undefined as unknown,
  navigate: vi.fn(),
  setRestricted: vi.fn(),
  setMember: vi.fn(),
  removeMember: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => m.navigate }));
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ userId: m.userId }) }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: locale } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: locale }) };
});
vi.mock('@/hooks/queries/use-legal-entities-queries', () => ({
  useLegalEntityAccess: () => ({ data: m.access, isLoading: false, error: null, refetch: vi.fn() }),
  useSetLegalEntityRestricted: () => ({ mutateAsync: m.setRestricted, isPending: false }),
  useSetLegalEntityMember: () => ({ mutateAsync: m.setMember, isPending: false }),
  useRemoveLegalEntityMember: () => ({ mutateAsync: m.removeMember, isPending: false }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceRoles: () => ({ data: { data: [] }, isLoading: false }),
  useWorkspaceMemberDirectory: () => ({ data: { data: [] }, isLoading: false }),
}));
// Radix Select needs pointer APIs jsdom lacks; the role picker isn't under test here.
vi.mock('@weldsuite/ui/components/select', () => ({
  Select: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
}));

import { AccessTab } from './access-tab';

const ta = en.settings.legalEntities.access;

function member(userId: string): LegalEntityAccessMember {
  return {
    userId,
    name: userId,
    email: `${userId}@example.com`,
    picture: null,
    workspaceRole: 'ADMIN',
    workspaceRoleName: 'Admin',
    roleId: null,
    roleName: null,
    grantedBy: 'u_owner',
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
  } as LegalEntityAccessMember;
}

function entity(source: 'owner' | 'manager'): LegalEntity {
  return { id: 'ent_1', name: 'Acme BV', myAccess: { source, roleId: null, roleName: null } } as unknown as LegalEntity;
}

function setAccess(restricted: boolean, listed: string[]) {
  m.access = { entityId: 'ent_1', restricted, members: listed.map(member) } satisfies LegalEntityAccess;
}

describe('AccessTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.userId = 'u_admin';
    m.navigate.mockResolvedValue(undefined);
    m.setRestricted.mockResolvedValue({});
    m.removeMember.mockResolvedValue(undefined);
  });

  it('asks before an admin who is not listed restricts the entity, then goes back to the list', async () => {
    setAccess(false, ['u_other']);
    render(<AccessTab entity={entity('manager')} />);

    fireEvent.click(screen.getByRole('switch'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(ta.restrictSelfTitle)).toBeTruthy();
    expect(m.setRestricted).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: ta.restrictSelfConfirm }));
    await waitFor(() => expect(m.setRestricted).toHaveBeenCalledWith(true));
    await waitFor(() => expect(m.navigate).toHaveBeenCalledWith({ to: '/settings/legal-entities' }));
  });

  it('leaves the entity alone when the admin cancels', async () => {
    setAccess(false, []);
    render(<AccessTab entity={entity('manager')} />);

    fireEvent.click(screen.getByRole('switch'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.common.actions.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(m.setRestricted).not.toHaveBeenCalled();
    expect(m.navigate).not.toHaveBeenCalled();
  });

  it('restricts straight away for a listed admin and for an owner', async () => {
    setAccess(false, ['u_admin']);
    const { unmount } = render(<AccessTab entity={entity('manager')} />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(m.setRestricted).toHaveBeenCalledWith(true));
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    m.userId = 'u_owner';
    setAccess(false, []);
    render(<AccessTab entity={entity('owner')} />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(m.setRestricted).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(m.navigate).not.toHaveBeenCalled();
  });

  it('warns an admin who takes themselves off a restricted entity, then goes back to the list', async () => {
    setAccess(true, ['u_admin']);
    render(<AccessTab entity={entity('manager')} />);

    fireEvent.click(screen.getByRole('button', { name: ta.remove }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(ta.removeSelfDescription)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: ta.remove }));
    await waitFor(() => expect(m.removeMember).toHaveBeenCalledWith('u_admin'));
    await waitFor(() => expect(m.navigate).toHaveBeenCalledWith({ to: '/settings/legal-entities' }));
  });

  it('keeps the usual warning, and the page, when removing someone else', async () => {
    setAccess(true, ['u_other']);
    render(<AccessTab entity={entity('manager')} />);

    fireEvent.click(screen.getByRole('button', { name: ta.remove }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(ta.removeDescription)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: ta.remove }));
    await waitFor(() => expect(m.removeMember).toHaveBeenCalledWith('u_other'));
    expect(m.navigate).not.toHaveBeenCalled();
  });
});
