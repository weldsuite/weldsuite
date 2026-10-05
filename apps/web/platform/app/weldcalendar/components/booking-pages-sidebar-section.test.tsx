/**
 * Booking page sidebar rows: confirmation before delete with the upcoming-booking
 * count (TASK-893), activate / deactivate and the inactive marker (TASK-895
 * item 9), accessible names on the row's icon buttons (TASK-895 item 5).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@clerk/clerk-react', () => ({ useOrganization: () => ({ organization: { slug: 'acme' } }) }));

const pathname = vi.hoisted(() => ({ current: '/weldcalendar' }));
vi.mock('@/lib/router', () => ({ usePathname: () => pathname.current }));

const deleteBookingPage = vi.hoisted(() => vi.fn());
const toggleBookingPage = vi.hoisted(() => vi.fn());
const impact = vi.hoisted(() => ({
  current: { data: { data: { upcomingBookingCount: 3 } }, isLoading: false, isError: false },
}));
vi.mock('@/hooks/queries/use-calendar-queries', () => ({
  useBookingPageDeleteImpact: () => impact.current,
  useDeleteBookingPage: () => ({ mutateAsync: deleteBookingPage, isPending: false }),
  useToggleBookingPage: () => ({ mutateAsync: toggleBookingPage, isPending: false }),
}));

import { BookingPagesSidebarSection } from './booking-pages-sidebar-section';
import { SidebarProvider } from '@weldsuite/ui/components/sidebar';

const pages = [
  { id: 'bpg_1', name: 'Intro call', slug: 'intro-call', isActive: true },
  { id: 'bpg_2', name: 'Old offer', slug: 'old-offer', isActive: false },
];

function renderSection() {
  return render(<BookingPagesSidebarSection bookingPages={pages} />, { wrapper: SidebarProvider });
}

async function openMenu(name: string) {
  const trigger = screen.getByRole('button', { name: `Options for ${name}` });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return trigger;
}

beforeEach(() => {
  vi.clearAllMocks();
  pathname.current = '/weldcalendar';
  deleteBookingPage.mockResolvedValue(undefined);
  toggleBookingPage.mockResolvedValue({ data: { id: 'bpg_1', isActive: false } });
  impact.current = { data: { data: { upcomingBookingCount: 3 } }, isLoading: false, isError: false };
});

describe('BookingPagesSidebarSection', () => {
  it('names the link-copy and menu icon buttons', () => {
    renderSection();
    expect(screen.getByRole('button', { name: 'Copy booking link for Intro call' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Options for Intro call' })).toBeInTheDocument();
  });

  it('marks an inactive page and leaves active ones unmarked', () => {
    renderSection();
    expect(screen.getAllByText('Inactive')).toHaveLength(1);
  });

  it('asks before deleting and states the upcoming bookings and the dead links', async () => {
    renderSection();
    await openMenu('Intro call');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('It has 3 upcoming bookings.')).toBeInTheDocument();
    expect(screen.getByText(/public booking link stops working/)).toBeInTheDocument();
    expect(deleteBookingPage).not.toHaveBeenCalled();
  });

  it('deletes after confirming and leaves the page that is open', async () => {
    pathname.current = '/weldcalendar/scheduling/bpg_1/view';
    renderSection();
    await openMenu('Intro call');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete booking page' }));

    await waitFor(() => expect(deleteBookingPage).toHaveBeenCalledWith('bpg_1'));
    expect(toastMock.success).toHaveBeenCalledWith('Booking page "Intro call" deleted');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/weldcalendar/scheduling' }));
  });

  it('stays where it is when a different page is deleted', async () => {
    pathname.current = '/weldcalendar/scheduling/bpg_2/view';
    renderSection();
    await openMenu('Intro call');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete booking page' }));

    await waitFor(() => expect(deleteBookingPage).toHaveBeenCalledWith('bpg_1'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and toasts when the delete fails', async () => {
    deleteBookingPage.mockRejectedValue(new Error('boom'));
    renderSection();
    await openMenu('Intro call');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete booking page' }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Could not delete the booking page'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('deactivates an active page from the menu', async () => {
    renderSection();
    await openMenu('Intro call');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Deactivate' }));

    await waitFor(() => expect(toggleBookingPage).toHaveBeenCalledWith('bpg_1'));
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('"Intro call" is inactive'));
  });

  it('offers Activate for an inactive page', async () => {
    toggleBookingPage.mockResolvedValue({ data: { id: 'bpg_2', isActive: true } });
    renderSection();
    await openMenu('Old offer');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Activate' }));

    await waitFor(() => expect(toggleBookingPage).toHaveBeenCalledWith('bpg_2'));
    expect(toastMock.success).toHaveBeenCalledWith('Booking page "Old offer" is active');
  });
});
