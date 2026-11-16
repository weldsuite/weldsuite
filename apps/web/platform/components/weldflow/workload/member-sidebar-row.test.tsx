import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemberSidebarRow } from './member-sidebar-row';

describe('MemberSidebarRow', () => {
  it('shows the name, the line under it and the figures on the right', () => {
    render(<MemberSidebarRow name="Ann Lee" subtitle="Backend, QA" meta="40 h/week" metaSecondary="3 tasks" rowHeight={60} isExpanded={false} onToggle={vi.fn()} />);
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveTextContent('Ann Lee');
    expect(toggle).toHaveTextContent('Backend, QA');
    expect(toggle).toHaveTextContent('40 h/week');
    expect(toggle).toHaveTextContent('3 tasks');
    expect(toggle.parentElement).toHaveStyle({ height: '60px' });
  });

  it('falls back to initials and leaves out what it is not given', () => {
    render(<MemberSidebarRow name="Ann Lee" rowHeight={60} isExpanded={false} onToggle={vi.fn()} />);
    expect(screen.getByRole('button').textContent).toBe('AnAnn Lee');
  });

  it('opens and closes on a click, saying which it will do', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(<MemberSidebarRow name="Ann" rowHeight={60} isExpanded={false} onToggle={onToggle} toggleLabel="Show projects for Ann" />);
    const toggle = screen.getByRole('button', { name: 'Show projects for Ann' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<MemberSidebarRow name="Ann" rowHeight={60} isExpanded onToggle={onToggle} toggleLabel="Hide projects for Ann" />);
    expect(screen.getByRole('button', { name: 'Hide projects for Ann' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps its action outside the toggle', async () => {
    const onToggle = vi.fn();
    const onEdit = vi.fn();
    render(
      <MemberSidebarRow
        name="Ann"
        rowHeight={60}
        isExpanded={false}
        onToggle={onToggle}
        toggleLabel="Show projects for Ann"
        action={
          <button type="button" onClick={onEdit}>
            Edit
          </button>
        }
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Show projects for Ann' })).not.toContainElement(screen.getByRole('button', { name: 'Edit' }));
  });
});
