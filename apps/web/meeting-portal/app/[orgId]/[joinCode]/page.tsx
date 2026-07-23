import GuestJoinClient from './guest-join-client';

/**
 * Guest Join Page
 *
 * Self-contained page for external guests to join a meeting. State machine,
 * RTK lifecycle, and screen rendering all live in the orchestrator client
 * component below.
 */
export default function GuestJoinPage() {
  return <GuestJoinClient />;
}
