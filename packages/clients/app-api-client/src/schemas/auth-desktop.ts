import { z } from 'zod';

// ============================================================================
// Desktop sign-in handoff — POST /api/auth-desktop/ticket
//
// Mints a short-lived, single-use Clerk sign-in token so the desktop shell
// (opened via `weldsuite://auth?ticket=...`) can complete a session without
// the user re-entering credentials inside the Electron webview.
//
// The optional `returnTo` must use an allowed custom-scheme target; this is
// re-validated server-side to prevent ticket exfiltration.
// ============================================================================

export const createDesktopTicketInput = z.object({
  returnTo: z.string().url().optional(),
});

export type CreateDesktopTicketInput = z.infer<typeof createDesktopTicketInput>;

export interface DesktopTicket {
  ticket: string;
  expiresAt: number;
  returnTo: string;
}
