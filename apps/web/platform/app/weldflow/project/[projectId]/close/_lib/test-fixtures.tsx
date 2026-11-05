/** Fixtures shared by the tests of the close page (not imported by app code). */

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CloseChecklist, Lesson } from '@weldsuite/app-api-client/domains/project-closing';
import { CloseContext, type CloseAbilities, type CloseContextValue } from '../_components/close-context';

export function makeChecklist(overrides: Partial<CloseChecklist> = {}): CloseChecklist {
  return {
    projectId: 'prj_1',
    projectName: 'Customer Portal',
    status: 'Active',
    closed: false,
    closedAt: null,
    checks: [
      { key: 'deliverables', blocking: true, done: true, state: 'done', total: 2, satisfied: 2 },
      { key: 'changes', blocking: true, done: true, state: 'done', total: 0, satisfied: 0 },
      { key: 'raid', blocking: true, done: false, state: 'open', total: 2, satisfied: 1 },
      { key: 'benefits', blocking: true, done: false, state: 'open', total: 1, satisfied: 0 },
      { key: 'time', blocking: true, done: true, state: 'done', total: 3, satisfied: 3 },
      { key: 'lessons', blocking: false, done: false, state: 'open', total: 3, satisfied: 0 },
      { key: 'signoff', blocking: false, done: false, state: 'waiting', total: 0, satisfied: 0 },
    ],
    progress: { done: 3, total: 7 },
    canRequest: false,
    deliverables: [
      { id: 'd1', code: 'D1', title: 'Accounts', status: 'accepted', acceptedAt: '2026-11-04T10:00:00.000Z' },
      { id: 'd2', code: 'D2', title: 'Catalogue', status: 'in_progress', acceptedAt: null },
    ],
    raidItems: [
      { id: 'r1', kind: 'risk', code: 'R-5', title: 'SSO outage', status: 'monitoring', ownerId: 'u_sanne', handedOver: true },
      { id: 'r2', kind: 'assumption', code: 'A-2', title: 'Content by week 8', status: 'open', ownerId: null, handedOver: false },
    ],
    benefits: [
      {
        id: 'b1',
        code: 'B-1',
        title: 'Fewer tickets',
        status: 'measuring',
        ownerId: null,
        unit: 'tickets',
        baselineValue: '1150.0000',
        targetValue: '400.0000',
        realiseBy: '2027-06-30T00:00:00.000Z',
        latest: null,
      },
    ],
    time: { total: 3, approved: 3, billed: 0, open: 0 },
    finance: {
      currency: 'EUR',
      amountsVisible: true,
      budget: '193900.00',
      timeCost: '195200.00',
      snapshot: null,
      actual: '195200.00',
      variance: '1300.00',
      variancePercent: 0.7,
      overBudget: true,
      baseline: { version: 5, goLive: '2027-01-15T00:00:00.000Z' },
    },
    lessons: { total: 3, published: 0 },
    signOff: { state: 'none', sponsorId: 'u_noor', approval: null },
    ...overrides,
  };
}

export function makeLesson(overrides: Partial<Lesson> & Pick<Lesson, 'id'>): Lesson {
  return {
    projectId: 'prj_1',
    category: 'went_well',
    text: `Lesson ${overrides.id}`,
    authorId: 'u_sanne',
    voteCount: 0,
    votedByMe: false,
    knowPageId: null,
    createdBy: 'u_sanne',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

export const MEMBERS = [
  { userId: 'u_noor', name: 'Noor Hendriks', email: 'noor@example.test', avatar: null },
  { userId: 'u_sanne', name: 'Sanne Jansen', email: 'sanne@example.test', avatar: null },
  { userId: 'u_daan', name: 'Daan Bakker', email: 'daan@example.test', avatar: null },
];

export const ALL_ABILITIES: CloseAbilities = {
  manage: true,
  addLessons: true,
  voteLessons: true,
  editLessons: true,
  deleteLessons: true,
  publishLessons: true,
  saveTemplate: true,
};

export const NO_ABILITIES: CloseAbilities = {
  manage: false,
  addLessons: false,
  voteLessons: false,
  editLessons: false,
  deleteLessons: false,
  publishLessons: false,
  saveTemplate: false,
};

export function contextValue(overrides: Partial<CloseContextValue> = {}): CloseContextValue {
  return {
    projectId: 'prj_1',
    checklist: makeChecklist(),
    userId: 'u_sanne',
    isManager: true,
    abilities: ALL_ABILITIES,
    members: MEMBERS,
    memberOf: (userId) => MEMBERS.find((member) => member.userId === userId) ?? null,
    ...overrides,
  };
}

export function Providers({ value, children }: Readonly<{ value: CloseContextValue; children: ReactNode }>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <CloseContext.Provider value={value}>{children}</CloseContext.Provider>
    </QueryClientProvider>
  );
}
