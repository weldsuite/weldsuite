import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import { plural as pluralFor } from '@weldsuite/i18n/plural';
import type { Lesson } from '@weldsuite/app-api-client/domains/project-closing';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    language: 'en',
    t: en,
    plural: (count: number, forms: Parameters<typeof pluralFor>[1]) => pluralFor(count, forms, 'en'),
    format: interpolate,
  }),
}));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const api = vi.hoisted(() => ({
  lessons: { data: [] as unknown[] | undefined, isLoading: false, isError: false, refetch: vi.fn() },
  toggle: { mutate: vi.fn(), isPending: false, variables: undefined as { id: string } | undefined },
  create: { mutateAsync: vi.fn(), isPending: false },
  update: { mutateAsync: vi.fn(), isPending: false },
  remove: { mutateAsync: vi.fn(), isPending: false },
  publish: { mutateAsync: vi.fn(), isPending: false },
  spaces: { data: { data: [] as unknown[] }, isLoading: false, isError: false },
}));
vi.mock('@/hooks/queries/use-project-closing-queries', () => ({
  useLessons: () => api.lessons,
  useToggleLessonVote: () => api.toggle,
  useCreateLesson: () => api.create,
  useUpdateLesson: () => api.update,
  useDeleteLesson: () => api.remove,
  usePublishLessons: () => api.publish,
}));
vi.mock('@/hooks/queries/use-knowledge-queries', () => ({ useKnowledgeSpaces: () => api.spaces }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { LessonsBoard } from './lessons-board';
import { ALL_ABILITIES, NO_ABILITIES, Providers, contextValue, makeLesson } from '../_lib/test-fixtures';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

const lessons: Lesson[] = [
  makeLesson({ id: 'a', text: 'Older, fewer votes', voteCount: 2, createdAt: '2026-10-01T00:00:00.000Z' }),
  makeLesson({ id: 'b', text: 'Most votes', voteCount: 6, votedByMe: true, createdAt: '2026-10-05T00:00:00.000Z', authorId: 'u_daan' }),
  makeLesson({ id: 'c', text: 'Went badly', category: 'went_badly', voteCount: 1, knowPageId: 'page_9' }),
];

beforeEach(() => {
  api.lessons.data = lessons;
  api.lessons.isLoading = false;
  api.lessons.isError = false;
  api.toggle.mutate.mockReset();
  api.create.mutateAsync.mockReset().mockResolvedValue({});
  api.remove.mutateAsync.mockReset().mockResolvedValue(undefined);
  api.spaces.data = { data: [] };
});

function setup(overrides: Parameters<typeof contextValue>[0] = {}) {
  render(
    <Providers value={contextValue(overrides)}>
      <LessonsBoard />
    </Providers>,
  );
}

describe('LessonsBoard', () => {
  it('shows three columns with their cards sorted by votes', () => {
    setup();
    const well = screen.getByRole('group', { name: 'Went well' });
    const texts = within(well)
      .getAllByRole('article')
      .map((card) => card.querySelector('p')?.textContent);
    expect(texts).toEqual(['Most votes', 'Older, fewer votes']);
    expect(within(screen.getByRole('group', { name: "Didn't go well" })).getByText('Went badly')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Do differently' })).getByText(/Nothing here yet/)).toBeInTheDocument();
  });

  it('summarizes the lessons and how many are published', () => {
    setup();
    expect(screen.getByText('3 lessons · 1 published to WeldKnow')).toBeInTheDocument();
  });

  it('toggles a vote and tells whether I voted', async () => {
    setup();
    const voted = screen.getByRole('button', { name: 'Vote for this lesson, 6 votes' });
    expect(voted).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(voted);
    expect(api.toggle.mutate).toHaveBeenCalledWith({ id: 'b', vote: false }, expect.anything());
    const open = screen.getByRole('button', { name: 'Vote for this lesson, 2 votes' });
    expect(open).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(open);
    expect(api.toggle.mutate).toHaveBeenLastCalledWith({ id: 'a', vote: true }, expect.anything());
  });

  it('lets a manager edit and delete every lesson', () => {
    setup();
    expect(screen.getAllByRole('button', { name: 'Edit this lesson' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Delete this lesson' })).toHaveLength(3);
  });

  it('lets a member change only their own lessons', () => {
    setup({ isManager: false, userId: 'u_daan' });
    expect(screen.getAllByRole('button', { name: 'Edit this lesson' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Delete this lesson' })).toHaveLength(1);
  });

  it('deletes a lesson after a confirmation', async () => {
    setup();
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete this lesson' })[0]);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete lesson' }));
    expect(api.remove.mutateAsync).toHaveBeenCalledWith('b');
  });

  it('adds a lesson to a column with its category preselected', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Add a lesson to “Didn\'t go well”' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a lesson' });
    expect(within(dialog).getByRole('combobox', { name: 'Category' })).toHaveTextContent("Didn't go well");
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Lesson' }), 'Test earlier');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add lesson' }));
    expect(api.create.mutateAsync).toHaveBeenCalledWith({ projectId: 'prj_1', category: 'went_badly', text: 'Test earlier' });
  });

  it('asks for the lesson text before saving', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Add lesson' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add lesson' }));
    expect(await within(dialog).findByText('This field is required')).toBeInTheDocument();
    expect(api.create.mutateAsync).not.toHaveBeenCalled();
  });

  it('links a published lesson to its WeldKnow page', () => {
    setup();
    expect(screen.getByRole('link', { name: 'Open the published page in WeldKnow' })).toHaveAttribute('href', '/weldknow/page/page_9');
  });

  it('is read-only without write abilities', () => {
    setup({ abilities: NO_ABILITIES, isManager: false });
    expect(screen.queryByRole('button', { name: 'Add lesson' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish lessons to WeldKnow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit this lesson' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vote for this lesson, 6 votes' })).toBeDisabled();
  });

  it('publishes only to a teamspace the person can write in', async () => {
    api.spaces.data = {
      data: [
        { id: 'sp_1', name: 'Engineering', kind: 'team', canWrite: true },
        { id: 'sp_2', name: 'Read only', kind: 'team', canWrite: false },
      ],
    };
    api.publish.mutateAsync.mockResolvedValue({ data: { pageId: 'page_1', spaceId: 'sp_1', title: 'x', lessonCount: 3 } });
    setup({ abilities: ALL_ABILITIES });
    await userEvent.click(screen.getByRole('button', { name: 'Publish lessons to WeldKnow' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish lessons to WeldKnow' });
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Teamspace' }));
    expect(screen.queryByRole('option', { name: 'Read only' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('option', { name: 'Engineering' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    expect(api.publish.mutateAsync).toHaveBeenCalledWith({ projectId: 'prj_1', spaceId: 'sp_1', locale: 'en' });
    expect(await screen.findByRole('link', { name: 'Open the page in WeldKnow' })).toHaveAttribute('href', '/weldknow/page/page_1');
  });

  it('offers a retry when the lessons could not be loaded', async () => {
    api.lessons.data = undefined;
    api.lessons.isError = true;
    setup();
    expect(screen.getByRole('alert')).toHaveTextContent('The lessons could not be loaded.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(api.lessons.refetch).toHaveBeenCalled();
  });
});
