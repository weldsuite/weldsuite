import { createMobileQueryClient } from '@weldsuite/mobile-realtime';

export const queryClient = createMobileQueryClient();

/**
 * Every key starts with `weldhr`, the same root the platform uses, so one
 * realtime `hr_*` event refreshes whatever WeldHR screen is mounted.
 */
export const weldhrKeys = {
  all: ['weldhr'] as const,
  access: () => [...weldhrKeys.all, 'access'] as const,
  me: () => [...weldhrKeys.all, 'me'] as const,
  overview: () => [...weldhrKeys.all, 'me', 'overview'] as const,
  attendance: (from: string, to: string) => [...weldhrKeys.all, 'me', 'attendance', from, to] as const,
  leave: () => [...weldhrKeys.all, 'me', 'leave'] as const,
  absences: () => [...weldhrKeys.all, 'me', 'absences'] as const,
  declarations: () => [...weldhrKeys.all, 'me', 'declarations'] as const,
  tasks: () => [...weldhrKeys.all, 'me', 'tasks'] as const,
  coaching: () => [...weldhrKeys.all, 'me', 'coaching'] as const,
  evaluations: () => [...weldhrKeys.all, 'me', 'evaluations'] as const,
  payslips: () => [...weldhrKeys.all, 'me', 'payslips'] as const,
  annualStatements: () => [...weldhrKeys.all, 'me', 'annual-statements'] as const,
  team: () => [...weldhrKeys.all, 'team'] as const,
  dashboard: () => [...weldhrKeys.team(), 'dashboard'] as const,
  pendingLeave: () => [...weldhrKeys.team(), 'leave', 'pending'] as const,
  pendingExpenses: () => [...weldhrKeys.team(), 'declarations', 'pending'] as const,
  sickToday: () => [...weldhrKeys.team(), 'absences', 'ongoing'] as const,
  employees: (search: string) => [...weldhrKeys.team(), 'employees', search] as const,
  employee: (id: string) => [...weldhrKeys.team(), 'employee', id] as const,
};
