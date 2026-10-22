import { TASK_SECTION_ORDER, dueToday, groupTasks, matchesTaskFilters, sectionFor, type GroupableTask } from '@/lib/task-groups';

const NOW = new Date(2026, 7, 5, 9, 30);
const at = (day: number) => new Date(2026, 7, day, 12).toISOString();

const task = (overrides: Partial<GroupableTask> = {}): GroupableTask => ({
  title: 'Call Acme',
  completed: false,
  status: 'todo',
  ...overrides,
});

describe('sectionFor', () => {
  it('buckets open tasks by due date', () => {
    expect(sectionFor(task({ dueDate: at(4) }), NOW)).toBe('overdue');
    expect(sectionFor(task({ dueDate: at(5) }), NOW)).toBe('today');
    expect(sectionFor(task({ dueDate: at(6) }), NOW)).toBe('tomorrow');
    expect(sectionFor(task({ dueDate: at(9) }), NOW)).toBe('thisWeek');
    expect(sectionFor(task({ dueDate: at(25) }), NOW)).toBe('later');
    expect(sectionFor(task(), NOW)).toBe('noDate');
  });

  it('puts finished tasks in completed whatever their date', () => {
    expect(sectionFor(task({ completed: true, status: 'done', dueDate: at(1) }), NOW)).toBe('completed');
  });
});

describe('groupTasks', () => {
  it('returns every section, keeping input order inside each', () => {
    const a = task({ title: 'a', dueDate: at(5) });
    const b = task({ title: 'b', dueDate: at(5) });
    const groups = groupTasks([a, b, task({ title: 'c' })], NOW);
    expect(Object.keys(groups)).toEqual([...TASK_SECTION_ORDER]);
    expect(groups.today.map((t) => t.title)).toEqual(['a', 'b']);
    expect(groups.noDate).toHaveLength(1);
  });
});

describe('matchesTaskFilters', () => {
  it('matches title and company text, case-insensitively', () => {
    expect(matchesTaskFilters(task(), 'acme', null)).toBe(true);
    expect(matchesTaskFilters(task({ record: { name: 'Globex' } }), 'GLOBEX', null)).toBe(true);
    expect(matchesTaskFilters(task(), 'zzz', null)).toBe(false);
  });

  it('applies the status filter', () => {
    expect(matchesTaskFilters(task({ status: 'backlog' }), '', 'backlog')).toBe(true);
    expect(matchesTaskFilters(task({ status: 'backlog' }), '', 'done')).toBe(false);
  });
});

describe('dueToday', () => {
  it('keeps open tasks due today or overdue, oldest first', () => {
    const tasks = [
      task({ title: 'today', dueDate: at(5) }),
      task({ title: 'tomorrow', dueDate: at(6) }),
      task({ title: 'overdue', dueDate: at(2) }),
      task({ title: 'done', dueDate: at(4), completed: true, status: 'done' }),
      task({ title: 'no date' }),
    ];
    expect(dueToday(tasks, NOW).map((item) => item.title)).toEqual(['overdue', 'today']);
  });
});
