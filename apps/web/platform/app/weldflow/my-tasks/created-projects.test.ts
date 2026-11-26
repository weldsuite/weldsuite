import { describe, expect, it } from 'vitest';
import { FolderKanban } from 'lucide-react';
import { coloredSquareColors } from '@/components/app-sidebar-layout';
import { createdProject, projectPickerOption, withCreatedProjects } from './created-projects';

describe('projects made from the task dialog', () => {
  it('adds the new ones to the fetched list until it has them itself', () => {
    const fetched = [{ id: 'p1', name: 'Website' }];
    expect(withCreatedProjects(fetched, [{ id: 'p2', name: 'Acme' }]).map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(withCreatedProjects([...fetched, { id: 'p2', name: 'Acme' }], [{ id: 'p2', name: 'Acme' }]).map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('reads the project a create call made, or null when it failed', () => {
    expect(createdProject({ success: true, data: { id: 'p2', name: 'Acme', color: '#f00', icon: 'Rocket' } }, 'Acme')).toEqual({ id: 'p2', name: 'Acme', color: '#f00', icon: 'Rocket' });
    expect(createdProject({ success: true, data: { id: 'p3', name: '' } }, 'Typed name')).toEqual({ id: 'p3', name: 'Typed name', color: null, icon: null });
    expect(createdProject({ success: false }, 'Acme')).toBeNull();
    expect(createdProject({ success: true, data: null }, 'Acme')).toBeNull();
  });

  it('shows a project in the picker as its coloured square, a folder in the first colour by default', () => {
    expect(projectPickerOption({ id: 'p1', name: 'Website' })).toEqual({ id: 'p1', name: 'Website', icon: FolderKanban, iconColor: coloredSquareColors[0].value });
    expect(projectPickerOption({ id: 'p2', name: 'Acme', color: '#f00', icon: 'not-an-icon' }).iconColor).toBe('#f00');
  });
});
