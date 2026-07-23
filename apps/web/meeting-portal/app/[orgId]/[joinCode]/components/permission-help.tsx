'use client';

import { CircleAlert } from 'lucide-react';

type Browser = 'chrome' | 'firefox' | 'safari' | 'edge' | 'other';

function detectBrowser(): Browser {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('firefox')) return 'firefox';
  if (ua.includes('chrome')) return 'chrome';
  if (ua.includes('safari')) return 'safari';
  return 'other';
}

function browserSteps(browser: Browser, kind: 'microphone' | 'camera'): string[] {
  const device = kind === 'microphone' ? 'Microphone' : 'Camera';
  switch (browser) {
    case 'chrome':
    case 'edge':
      return [
        'Click the lock or tune icon on the left side of the address bar.',
        `Find "${device}" and switch it to "Allow".`,
        'Reload this page.',
      ];
    case 'firefox':
      return [
        'Click the lock icon in the address bar.',
        `Remove the "Blocked" entry for ${device}.`,
        'Reload this page.',
      ];
    case 'safari':
      return [
        'Open Safari → Settings for This Website…',
        `Set "${device}" to "Allow".`,
        'Reload this page.',
      ];
    default:
      return [
        'Open your browser\'s site settings for this page.',
        `Allow ${device.toLowerCase()} access.`,
        'Reload this page.',
      ];
  }
}

export function PermissionHelp({ kind }: { kind: 'microphone' | 'camera' }) {
  const label = kind === 'microphone' ? 'Microphone' : 'Camera';
  const steps = browserSteps(detectBrowser(), kind);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <CircleAlert className="h-3.5 w-3.5 text-amber-500" strokeWidth={2.5} />
        <span className="text-sm font-semibold">{label} access blocked</span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Your browser is blocking {label.toLowerCase()} access for this site. To fix it:
      </p>
      <ol className="text-xs text-foreground/90 list-decimal pl-4 space-y-1.5">
        {steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
    </div>
  );
}
