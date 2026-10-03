import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const navigate = vi.fn();
const joinMeeting = vi.fn();
const cancelPreview = vi.fn();
let call: { status: string; meetingId: string | null };

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ meetingId: 'mtg_1' }),
  useNavigate: () => navigate,
}));
vi.mock('@/contexts/weldmeet-call-context', () => ({
  useWeldMeetCall: () => ({ ...call, joinMeeting, cancelPreview }),
}));
// The meeting is already cached, as when the user clicks Start on the detail page.
vi.mock('@/hooks/queries/use-weldmeet-queries', () => ({
  useMeeting: () => ({ data: { id: 'mtg_1', organizerId: 'user_1', meetingType: 'video', title: 'Standup' } }),
}));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'user_1' }) }));
vi.mock('@/lib/i18n', () => ({
  getTranslations: () => ({ meetingRoomPage: { preparingRoom: 'Preparing room' } }),
}));
vi.mock('@/lib/weldmeet/start-handoff', () => ({ peekStartHandoff: () => false }));
const breadcrumbs = vi.fn();
vi.mock('@/contexts/breadcrumb-context', () => ({ useOptionalBreadcrumbs: (s: unknown) => breadcrumbs(s) }));
vi.mock('@/app/weldmeet/components/meeting-overlay', () => ({ InlineMeetingView: () => null }));

import MeetingRoomPage from './page';

beforeEach(() => {
  navigate.mockReset();
  joinMeeting.mockReset();
  cancelPreview.mockReset();
  call = { status: 'idle', meetingId: null };
});

describe('MeetingRoomPage', () => {
  it('joins without bouncing back to the detail page while the call is still idle', () => {
    render(<MeetingRoomPage />);

    expect(joinMeeting).toHaveBeenCalledTimes(1);
    expect(joinMeeting).toHaveBeenCalledWith('mtg_1', expect.objectContaining({ isOrganizer: true, skipPreview: false }));
    expect(navigate).not.toHaveBeenCalled();
    expect(breadcrumbs).toHaveBeenLastCalledWith([{ label: 'Standup' }]);
  });

  it('returns to the detail page once a started call goes back to idle', () => {
    const { rerender } = render(<MeetingRoomPage />);

    call = { status: 'preview', meetingId: 'mtg_1' };
    rerender(<MeetingRoomPage />);
    expect(navigate).not.toHaveBeenCalled();

    call = { status: 'idle', meetingId: null };
    rerender(<MeetingRoomPage />);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ to: '/weldmeet/$meetingId', params: { meetingId: 'mtg_1' } });
  });

  it('ignores a call that belongs to another meeting', () => {
    call = { status: 'connected', meetingId: 'mtg_other' };
    const { rerender } = render(<MeetingRoomPage />);

    call = { status: 'idle', meetingId: null };
    rerender(<MeetingRoomPage />);
    expect(navigate).not.toHaveBeenCalled();
  });
});
