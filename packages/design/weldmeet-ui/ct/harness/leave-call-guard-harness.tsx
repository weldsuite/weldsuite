import { useLeaveCallGuard } from '../../src/hooks/use-leave-call-guard';

/**
 * Mounts `useLeaveCallGuard`. `onLeave` records itself in sessionStorage, which
 * survives the reload the spec triggers, so the spec can read it afterwards.
 */
export function LeaveCallGuardHarness({ warn }: { warn: boolean }) {
  useLeaveCallGuard({
    warn,
    onLeave: () => sessionStorage.setItem('left-call', 'yes'),
  });
  return <button type="button">in call</button>;
}
