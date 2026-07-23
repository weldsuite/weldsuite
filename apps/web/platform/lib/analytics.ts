// mixpanel-browser is ~800 KB. Lazy-load it so it never enters the main
// bundle — initMixpanel() pulls the SDK on demand, and track/identify/etc.
// queue their calls until the SDK is ready (or drop silently if it never
// is, e.g. when no Mixpanel token is configured).

type MixpanelModule = typeof import('mixpanel-browser').default;

let mixpanelInstance: MixpanelModule | null = null;
let initPromise: Promise<MixpanelModule | null> | null = null;
let isInitialized = false;

function loadMixpanel(): Promise<MixpanelModule> {
  return import('mixpanel-browser').then((m) => m.default);
}

export function initMixpanel(token: string, debug = false) {
  if (isInitialized || !token) return;
  if (initPromise) return;

  initPromise = loadMixpanel().then((mixpanel) => {
    mixpanel.init(token, {
      debug,
      track_pageview: false,
      persistence: 'localStorage',
      api_host: 'https://api-eu.mixpanel.com',
    });

    mixpanel.register({ app: 'platform' });

    const params = new URLSearchParams(window.location.search);
    const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
    const utms: Record<string, string> = {};
    let hasUtm = false;

    for (const key of utmKeys) {
      const value = params.get(key);
      if (value) {
        utms[key] = value;
        hasUtm = true;
      }
    }

    if (hasUtm) {
      mixpanel.register(utms);
      try {
        localStorage.setItem('mp_utms', JSON.stringify(utms));
      } catch {}
    } else {
      try {
        const stored = localStorage.getItem('mp_utms');
        if (stored) {
          mixpanel.register(JSON.parse(stored));
        }
      } catch {}
    }

    mixpanelInstance = mixpanel;
    isInitialized = true;
    return mixpanel;
  });
}

export function track(event: string, props?: Record<string, unknown>) {
  if (!mixpanelInstance) return;
  mixpanelInstance.track(event, props);
}

export function identify(userId: string) {
  if (!mixpanelInstance) return;
  mixpanelInstance.identify(userId);
}

export function setUserProperties(props: Record<string, unknown>) {
  if (!mixpanelInstance) return;
  mixpanelInstance.people.set(props);
}

function reset() {
  if (!mixpanelInstance) return;
  mixpanelInstance.reset();
}
