import { linkNeedsDetail, recordAppFor, recordAppLink } from '../app-links';

describe('recordAppLink', () => {
  it('opens companies and people in WeldCRM', () => {
    expect(recordAppLink('company', 'cmp_1')).toEqual({ app: 'WeldCRM', url: 'weldcrm://company/cmp_1' });
    expect(recordAppLink('person', 'per_1')).toEqual({ app: 'WeldCRM', url: 'weldcrm://person/per_1' });
  });

  it('opens projects in WeldFlow', () => {
    expect(recordAppLink('project', 'prj_1')).toEqual({ app: 'WeldFlow', url: 'weldflow://project/prj_1' });
  });

  it('opens a task under its project, and not without one', () => {
    expect(linkNeedsDetail('task')).toBe(true);
    expect(recordAppLink('task', 'tsk_1', { projectId: 'prj_1' })).toEqual({
      app: 'WeldFlow',
      url: 'weldflow://task/prj_1/tsk_1',
    });
    expect(recordAppLink('task', 'tsk_1')).toBeNull();
    expect(recordAppLink('task', 'tsk_1', { projectId: null })).toBeNull();
  });

  it('has no app for domains or legacy types', () => {
    expect(recordAppFor('domain')).toBeNull();
    expect(recordAppLink('domain', 'dom_1')).toBeNull();
    expect(recordAppLink('contact', 'per_1')).toBeNull();
  });

  it('escapes ids', () => {
    expect(recordAppLink('company', 'a/b c')!.url).toBe('weldcrm://company/a%2Fb%20c');
  });
});
