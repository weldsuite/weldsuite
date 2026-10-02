import { CircleAlert } from 'lucide-react';

export type PermissionKind = 'microphone' | 'camera';

type Browser = 'chromium' | 'firefox' | 'safari' | 'other';

/**
 * Copy for the "access blocked" help. Step strings may contain `{device}`,
 * replaced with `microphoneDevice` / `cameraDevice`, the device name exactly
 * as the browser's site-settings panel shows it in the user's language.
 * Shared by the platform (which passes translated copy) and the meeting
 * portal (English defaults).
 */
export interface PermissionHelpLabels {
  microphoneTitle: string;
  cameraTitle: string;
  microphoneDescription: string;
  cameraDescription: string;
  /** Tooltip + aria-label of the blocked mic button. */
  microphoneBlockedAction: string;
  /** Tooltip + aria-label of the blocked camera button. */
  cameraBlockedAction: string;
  microphoneDevice: string;
  cameraDevice: string;
  steps: Record<Browser, readonly string[]>;
}

export const DEFAULT_PERMISSION_HELP_LABELS: PermissionHelpLabels = {
  microphoneTitle: 'Microphone access blocked',
  cameraTitle: 'Camera access blocked',
  microphoneDescription: 'Your browser is blocking microphone access for this site. To fix it:',
  cameraDescription: 'Your browser is blocking camera access for this site. To fix it:',
  microphoneBlockedAction: 'Microphone access blocked — click for help',
  cameraBlockedAction: 'Camera access blocked — click for help',
  microphoneDevice: 'Microphone',
  cameraDevice: 'Camera',
  steps: {
    chromium: [
      'Click the lock or tune icon on the left side of the address bar.',
      'Find "{device}" and switch it to "Allow".',
      'Reload this page.',
    ],
    firefox: [
      'Click the lock icon in the address bar.',
      'Remove the "Blocked" entry for {device}.',
      'Reload this page.',
    ],
    safari: [
      'Open Safari → Settings for This Website…',
      'Set "{device}" to "Allow".',
      'Reload this page.',
    ],
    other: [
      "Open your browser's site settings for this page.",
      'Allow access to "{device}".',
      'Reload this page.',
    ],
  },
};

function detectBrowser(): Browser {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('edg/') || ua.includes('chrome')) return 'chromium';
  if (ua.includes('firefox')) return 'firefox';
  if (ua.includes('safari')) return 'safari';
  return 'other';
}

export function PermissionHelp({
  kind,
  labels = DEFAULT_PERMISSION_HELP_LABELS,
}: Readonly<{ kind: PermissionKind; labels?: PermissionHelpLabels }>) {
  const isMic = kind === 'microphone';
  const device = isMic ? labels.microphoneDevice : labels.cameraDevice;
  const steps = labels.steps[detectBrowser()].map((s) => s.replace(/\{device\}/g, device));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <CircleAlert className="h-3.5 w-3.5 text-amber-500" strokeWidth={2.5} />
        <span className="text-sm font-semibold">{isMic ? labels.microphoneTitle : labels.cameraTitle}</span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {isMic ? labels.microphoneDescription : labels.cameraDescription}
      </p>
      <ol className="text-xs text-foreground/90 list-decimal pl-4 space-y-1.5">
        {steps.map((s) => <li key={s}>{s}</li>)}
      </ol>
    </div>
  );
}
