import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrAnnouncement } from '@weldsuite/app-api-client/domains/weldhr';

const state = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  pending: { create: false, update: false },
}));

vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useCreateHrAnnouncement: () => ({ mutateAsync: state.create, isPending: state.pending.create }),
  useUpdateHrAnnouncement: () => ({ mutateAsync: state.update, isPending: state.pending.update }),
  useHrDepartments: () => ({ data: [{ id: 'dep_sales', name: 'Sales' }] }),
}));

import { AnnouncementDialog } from './announcement-dialog';

const t = en.weldhr.announcements;

const existing: HrAnnouncement = {
  id: 'ann_1',
  title: 'Office move',
  body: 'We move on Monday.',
  pinned: true,
  departmentIds: ['dep_sales'],
  departmentNames: ['Sales'],
  publishedAt: '2026-11-20T09:00:00Z',
  notifiedAt: null,
  createdBy: null,
  createdByName: null,
  audienceCount: 10,
  readCount: 4,
  createdAt: '2026-11-20T09:00:00Z',
  updatedAt: '2026-11-20T09:00:00Z',
};

function renderDialog(announcement?: HrAnnouncement) {
  const onClose = vi.fn();
  render(
    <I18nProvider initialLanguage="en">
      <AnnouncementDialog announcement={announcement} onClose={onClose} />
    </I18nProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  state.create.mockReset().mockResolvedValue({});
  state.update.mockReset().mockResolvedValue({});
  state.pending = { create: false, update: false };
});

describe('AnnouncementDialog', () => {
  describe('new', () => {
    it('cannot be posted until the title and message are filled in', async () => {
      const user = userEvent.setup();
      renderDialog();
      expect(screen.getByRole('heading', { name: t.addTitle })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: t.form.create })).toBeDisabled();
      await user.type(screen.getByLabelText(t.form.title), 'Hello');
      await user.type(screen.getByLabelText(t.form.body), 'World');
      await waitFor(() => expect(screen.getByRole('button', { name: t.form.create })).toBeEnabled());
    });

    it('offers the push notification and the pin as switches that are off', () => {
      renderDialog();
      expect(screen.getByRole('switch', { name: t.form.notify })).not.toBeChecked();
      expect(screen.getByRole('switch', { name: t.form.pinned })).not.toBeChecked();
    });

    it('posts with the pin and the push notification', async () => {
      const user = userEvent.setup();
      const { onClose } = renderDialog();
      await user.type(screen.getByLabelText(t.form.title), 'Hello');
      await user.type(screen.getByLabelText(t.form.body), 'World');
      await user.click(screen.getByRole('switch', { name: t.form.pinned }));
      await user.click(screen.getByRole('switch', { name: t.form.notify }));
      await waitFor(() => expect(screen.getByRole('button', { name: t.form.create })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: t.form.create }));

      await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
      expect(state.create.mock.calls[0]![0]).toMatchObject({ title: 'Hello', body: 'World', pinned: true, notify: true, departmentIds: [] });
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it('shows why posting failed and stays open', async () => {
      state.create.mockRejectedValue(new Error('Title taken'));
      const user = userEvent.setup();
      const { onClose } = renderDialog();
      await user.type(screen.getByLabelText(t.form.title), 'Hello');
      await user.type(screen.getByLabelText(t.form.body), 'World');
      await waitFor(() => expect(screen.getByRole('button', { name: t.form.create })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: t.form.create }));
      expect(await screen.findByText('Title taken')).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('falls back to a general message when the failure has none', async () => {
      state.create.mockRejectedValue('x');
      const user = userEvent.setup();
      renderDialog();
      await user.type(screen.getByLabelText(t.form.title), 'Hello');
      await user.type(screen.getByLabelText(t.form.body), 'World');
      await waitFor(() => expect(screen.getByRole('button', { name: t.form.create })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: t.form.create }));
      expect(await screen.findByText(t.form.failed)).toBeInTheDocument();
    });

    it('shows Saving and cannot be cancelled while posting', () => {
      state.pending.create = true;
      renderDialog();
      expect(screen.getByRole('button', { name: t.form.saving })).toBeDisabled();
      expect(screen.getByRole('button', { name: t.form.cancel })).toBeDisabled();
    });
  });

  describe('edit', () => {
    it('starts from the announcement, without the push notification option', async () => {
      renderDialog(existing);
      expect(screen.getByRole('heading', { name: t.editTitle })).toBeInTheDocument();
      expect(screen.getByLabelText(t.form.title)).toHaveValue('Office move');
      expect(screen.getByLabelText(t.form.body)).toHaveValue('We move on Monday.');
      expect(screen.getByRole('switch', { name: t.form.pinned })).toBeChecked();
      expect(screen.queryByRole('switch', { name: t.form.notify })).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: t.form.save })).toBeEnabled());
    });

    it('saves the change without sending another push', async () => {
      const user = userEvent.setup();
      const { onClose } = renderDialog(existing);
      await user.clear(screen.getByLabelText(t.form.title));
      await user.type(screen.getByLabelText(t.form.title), 'Office move (updated)');
      await user.click(screen.getByRole('switch', { name: t.form.pinned }));
      await waitFor(() => expect(screen.getByRole('button', { name: t.form.save })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: t.form.save }));

      await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
      expect(state.update.mock.calls[0]![0]).toEqual({
        id: 'ann_1',
        title: 'Office move (updated)',
        body: 'We move on Monday.',
        pinned: false,
        departmentIds: ['dep_sales'],
      });
      expect(state.create).not.toHaveBeenCalled();
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it('shows Saving while the change is saved', () => {
      state.pending.update = true;
      renderDialog(existing);
      expect(screen.getByRole('button', { name: t.form.saving })).toBeDisabled();
    });
  });

  it('closes with Cancel', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: t.form.cancel }));
    expect(onClose).toHaveBeenCalled();
  });
});
