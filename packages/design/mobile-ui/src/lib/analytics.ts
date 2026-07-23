import { Mixpanel } from 'mixpanel-react-native';

let mp: Mixpanel | null = null;

export async function initMixpanel(token: string) {
  if (mp || !token) return;

  mp = new Mixpanel(token, true);
  await mp.init();
  mp.registerSuperProperties({ app: 'mobile' });
}

export function track(event: string, props?: Record<string, unknown>) {
  if (!mp) return;
  mp.track(event, props);
}

export function identify(userId: string) {
  if (!mp) return;
  mp.identify(userId);
}

export function setUserProperties(props: Record<string, unknown>) {
  if (!mp) return;
  const people = mp.getPeople();
  for (const [key, value] of Object.entries(props)) {
    people.set(key, value as string);
  }
}

export function reset() {
  if (!mp) return;
  mp.reset();
}
