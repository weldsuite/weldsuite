import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useParams: () => ({ projectId: 'prj_1' }),
  usePathname: () => '/weldflow/project/prj_1/governance/changes',
}));

import { ProjectSubNavLayout, SubNavPills, activeSubNavId, type SubNavItem } from './sub-nav';

const items: SubNavItem[] = [
  { id: 'status', label: 'Status reports', path: '' },
  { id: 'decisions', label: 'Decisions', path: '/decisions' },
  { id: 'changes', label: 'Change requests', path: '/changes' },
];
const base = '/weldflow/project/prj_1/governance';

describe('activeSubNavId', () => {
  it('picks the section root for the base path, with or without a trailing slash', () => {
    expect(activeSubNavId(base, base, items)).toBe('status');
    expect(activeSubNavId(`${base}/`, base, items)).toBe('status');
  });

  it('picks the pill whose path matches exactly', () => {
    expect(activeSubNavId(`${base}/decisions`, base, items)).toBe('decisions');
    expect(activeSubNavId(`${base}/changes/`, base, items)).toBe('changes');
  });

  it('keeps the parent pill active on a page below it', () => {
    expect(activeSubNavId(`${base}/decisions/dec_9`, base, items)).toBe('decisions');
  });

  it('falls back to the section root for an unknown sub-page', () => {
    expect(activeSubNavId(`${base}/unknown`, base, items)).toBe('status');
  });

  it('does not mistake a longer sibling for a pill', () => {
    expect(activeSubNavId(`${base}/decisions-archive`, base, items)).toBe('status');
  });
});

describe('SubNavPills', () => {
  it('links every pill under the base path and marks the active one', () => {
    render(<SubNavPills label="Governance" basePath={base} items={items} activeId="decisions" />);
    expect(screen.getByRole('navigation', { name: 'Governance' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Status reports' })).toHaveAttribute('href', base);
    expect(screen.getByRole('link', { name: 'Change requests' })).toHaveAttribute('href', `${base}/changes`);
    expect(screen.getByRole('link', { name: 'Decisions' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Status reports' })).not.toHaveAttribute('aria-current');
  });
});

describe('ProjectSubNavLayout', () => {
  it('renders the sub-tabs for the project in the URL in the toolbar, and the page under them', () => {
    render(
      <ProjectSubNavLayout section="governance" label="Governance" items={items}>
        <p>page body</p>
      </ProjectSubNavLayout>,
    );
    // The toolbar and the phone-only row under it both carry the sub-tabs.
    for (const link of screen.getAllByRole('link', { name: 'Change requests' })) expect(link).toHaveAttribute('aria-current', 'page');
    for (const link of screen.getAllByRole('link', { name: 'Decisions' })) expect(link).toHaveAttribute('href', `${base}/decisions`);
    expect(screen.getByText('page body')).toBeInTheDocument();
  });

  it('lets a flush sub-page scroll edge to edge, without the padding', () => {
    const { container } = render(
      <ProjectSubNavLayout section="governance" label="Governance" items={items} flushIds={['changes']}>
        <p>page body</p>
      </ProjectSubNavLayout>,
    );
    expect(screen.getByText('page body').parentElement).toHaveClass('overflow-y-auto');
    expect(container.querySelector('.px-3.pt-4')).toBeNull();
  });

  it('lets the full-bleed pill lay out its own page', () => {
    const { container } = render(
      <ProjectSubNavLayout section="governance" label="Governance" items={items} fullBleedId="changes">
        <p>page body</p>
      </ProjectSubNavLayout>,
    );
    expect(container.querySelector('.overflow-y-auto')).toBeNull();
  });
});
