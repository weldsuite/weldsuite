import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  BreadcrumbProvider,
  useBreadcrumbs,
  useCurrentBreadcrumbs,
  type BreadcrumbSegment,
} from './breadcrumb-context';

const CRM: BreadcrumbSegment = { label: 'CRM', href: '/weldcrm' };
const PEOPLE: BreadcrumbSegment[] = [CRM, { label: 'People' }];
const SEQUENCES: BreadcrumbSegment[] = [CRM, { label: 'Sequences' }];

/** A module layout that sets the section crumb, like CrmSectionBreadcrumbs. */
function Layout({ segments, enabled }: Readonly<{ segments: BreadcrumbSegment[]; enabled: boolean }>) {
  useBreadcrumbs(segments, { enabled });
  return null;
}

/** A page that sets its own crumbs, like the Sequences list. */
function Page({ segments }: Readonly<{ segments: BreadcrumbSegment[] }>) {
  useBreadcrumbs(segments);
  return null;
}

function Trail() {
  const crumbs = useCurrentBreadcrumbs();
  return <span data-testid="trail">{crumbs.map((c) => c.label).join(' > ')}</span>;
}

function Tree({
  layout,
  page,
}: Readonly<{
  layout: { segments: BreadcrumbSegment[]; enabled: boolean };
  page: BreadcrumbSegment[] | null;
}>) {
  return (
    <BreadcrumbProvider defaultBreadcrumbs={[CRM]}>
      <Layout {...layout} />
      {page && <Page segments={page} />}
      <Trail />
    </BreadcrumbProvider>
  );
}

const trail = () => screen.getByTestId('trail').textContent;

describe('useBreadcrumbs', () => {
  it('shows the page crumbs and falls back to the default when the page unmounts', () => {
    const { rerender } = render(<Tree layout={{ segments: PEOPLE, enabled: false }} page={SEQUENCES} />);
    expect(trail()).toBe('CRM > Sequences');

    rerender(<Tree layout={{ segments: PEOPLE, enabled: false }} page={null} />);
    expect(trail()).toBe('CRM');
  });

  it('keeps the next section crumb when the previous page unmounts after it was set (Sequences to People)', () => {
    // The layout switches to People while the Sequences page is still mounted
    // (the People route is still loading); the Sequences page goes away later.
    const { rerender } = render(<Tree layout={{ segments: PEOPLE, enabled: false }} page={SEQUENCES} />);
    expect(trail()).toBe('CRM > Sequences');

    rerender(<Tree layout={{ segments: PEOPLE, enabled: true }} page={SEQUENCES} />);
    expect(trail()).toBe('CRM > People');

    rerender(<Tree layout={{ segments: PEOPLE, enabled: true }} page={null} />);
    expect(trail()).toBe('CRM > People');
  });

  it('keeps the new page crumbs when the section layout is disabled after the page set them (People to Sequences)', () => {
    const { rerender } = render(<Tree layout={{ segments: PEOPLE, enabled: true }} page={null} />);
    expect(trail()).toBe('CRM > People');

    // Sequences mounts and sets its crumbs, then the layout notices the path
    // change and disables itself, which must not reset the crumbs.
    rerender(<Tree layout={{ segments: PEOPLE, enabled: true }} page={SEQUENCES} />);
    expect(trail()).toBe('CRM > Sequences');
    rerender(<Tree layout={{ segments: PEOPLE, enabled: false }} page={SEQUENCES} />);
    expect(trail()).toBe('CRM > Sequences');
  });
});
