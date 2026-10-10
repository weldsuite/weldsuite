/**
 * The meeting room page is the one place every way into a meeting passes
 * through (the detail page's Join, a join code, a shared link). A user is in at
 * most one call, so when another call is live it asks BEFORE the pre-join
 * preview starts, and joins only once that call has been left.
 */

import { useReducer, useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const meet = vi.hoisted(() => ({
  state: {
    status: 'idle' as string,
    meetingId: null as string | null,
    joinMeeting: vi.fn(),
    cancelPreview: vi.fn(),
  },
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ meetingId: 'mtg_b' }),
  useNavigate: () => meet.navigate,
}));
vi.mock('@/contexts/weldmeet-call-context', () => ({ useWeldMeetCall: () => meet.state }));
vi.mock('@/hooks/queries/use-weldmeet-queries', () => ({
  useMeeting: () => ({
    data: { id: 'mtg_b', title: 'Design review', organizerId: 'user_host', meetingType: 'video' },
  }),
}));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'user_me' }) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useOptionalBreadcrumbs: () => undefined }));
vi.mock('@/lib/weldmeet/start-handoff', () => ({ peekStartHandoff: () => false }));
vi.mock('@/lib/i18n', () => ({
  getTranslations: () => ({
    meetingRoomPage: { preparingRoom: 'Preparing your room' },
    switchCallDialog: {
      currentCall: 'your current call',
      newCall: 'the new call',
      currentMeeting: 'your current meeting',
      newMeeting: 'a new meeting',
      meetingNamed: 'the meeting "{title}"',
    },
  }),
}));
vi.mock('@/app/weldmeet/components/meeting-overlay', () => ({
  InlineMeetingView: () => <div data-testid="inline-meeting" />,
}));

import MeetingRoomPage from './page';
import {
  ActiveCallProvider,
  useCallSwitchDialog,
  useRegisterActiveCall,
  type ActiveCallKind,
} from '@/contexts/active-call-context';

let switchDialog: ReturnType<typeof useCallSwitchDialog>;
function DialogProbe() {
  switchDialog = useCallSwitchDialog();
  return null;
}

/** Another call that is live; leaving it brings the provider status back to idle. */
function OtherCall({ kind, id, leave }: Readonly<{ kind: ActiveCallKind; id: string; leave: () => Promise<void> }>) {
  useRegisterActiveCall(kind, { id, label: 'the call with Alice', leave });
  return null;
}

/**
 * The page next to (optionally) another live call. The page only mounts once
 * `showPage` is set: in the app a live call registered long before the user
 * opened this room, whereas here both would otherwise mount in the same commit.
 */
function Harness({ other, showPage }: Readonly<{ other?: { kind: ActiveCallKind; id: string }; showPage: boolean }>) {
  const [live, setLive] = useState(!!other);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  endOtherCall = () => {
    meet.state.status = 'idle';
    meet.state.meetingId = null;
    setLive(false);
    rerender();
  };
  return (
    <ActiveCallProvider>
      <DialogProbe />
      {live && other ? <OtherCall kind={other.kind} id={other.id} leave={leaveOther} /> : null}
      {showPage ? <MeetingRoomPage /> : null}
    </ActiveCallProvider>
  );
}
let endOtherCall: () => void = () => undefined;
/** What the other call's provider does when asked to leave: its status goes back to idle. */
const leaveOther = vi.fn(async () => {
  endOtherCall();
});

/** Mounts the call that is already live, then opens the room page next to it. */
function openRoom(other?: { kind: ActiveCallKind; id: string }) {
  const view = render(<Harness other={other} showPage={false} />);
  view.rerender(<Harness other={other} showPage />);
}

beforeEach(() => {
  leaveOther.mockClear();
  meet.state.status = 'idle';
  meet.state.meetingId = null;
  meet.state.joinMeeting.mockClear();
  meet.state.cancelPreview.mockClear();
  meet.navigate.mockClear();
});

describe('MeetingRoomPage · joining while another call is live', () => {
  it('joins straight away when nothing else is live', () => {
    openRoom();

    expect(meet.state.joinMeeting).toHaveBeenCalledWith('mtg_b', expect.objectContaining({ title: 'Design review' }));
    expect(switchDialog?.dialog).toBeNull();
  });

  it('asks first, and does not touch the camera or join, while a WeldChat call is live', () => {
    openRoom({ kind: 'chat', id: 'call_1' });

    expect(switchDialog?.dialog).toEqual({
      target: { kind: 'meet', label: 'the meeting "Design review"' },
      current: 'the call with Alice',
      switching: false,
    });
    expect(meet.state.joinMeeting).not.toHaveBeenCalled();
  });

  it('asks about another meeting too, and shows its own room, not that meeting', () => {
    meet.state.status = 'connected';
    meet.state.meetingId = 'mtg_a';
    openRoom({ kind: 'meet', id: 'mtg_a' });

    expect(switchDialog?.dialog?.target.label).toBe('the meeting "Design review"');
    // Connected to meeting A: this page must not show A's room as if it were B's.
    expect(screen.queryByTestId('inline-meeting')).toBeNull();
    expect(screen.getByText('Preparing your room')).toBeTruthy();
    expect(meet.state.joinMeeting).not.toHaveBeenCalled();
  });

  it('leaves the live call on confirm, then joins this meeting', async () => {
    openRoom({ kind: 'chat', id: 'call_1' });

    await act(async () => {
      await switchDialog?.confirm();
    });

    expect(leaveOther).toHaveBeenCalledTimes(1);
    expect(meet.state.joinMeeting).toHaveBeenCalledTimes(1);
    expect(meet.state.joinMeeting).toHaveBeenCalledWith('mtg_b', expect.objectContaining({ title: 'Design review' }));
    expect(switchDialog?.dialog).toBeNull();
  });

  it('goes back to the meeting page on "Stay", and the live call is left alone', () => {
    openRoom({ kind: 'chat', id: 'call_1' });

    act(() => switchDialog?.dismiss());

    expect(meet.navigate).toHaveBeenCalledWith({ to: '/weldmeet/$meetingId', params: { meetingId: 'mtg_b' } });
    expect(leaveOther).not.toHaveBeenCalled();
    expect(meet.state.joinMeeting).not.toHaveBeenCalled();
  });

  it('does not ask about the meeting it is already in', async () => {
    meet.state.status = 'connected';
    meet.state.meetingId = 'mtg_b';
    openRoom({ kind: 'meet', id: 'mtg_b' });

    expect(switchDialog?.dialog).toBeNull();
    expect(await screen.findByTestId('inline-meeting')).toBeTruthy();
  });
});
