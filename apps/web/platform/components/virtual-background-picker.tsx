// Platform wrapper — the canonical implementation lives in
// `packages/design/weldmeet-ui/src/components/background-effects-panel.tsx`,
// shared with the meeting-portal app. Edit the shared file to change behavior.
// The wrapper only switches off the stock (Unsplash) backgrounds on a
// Kubernetes edition (EU, self-hosted), which loads nothing from third parties.
import {
  BackgroundEffectsPanel as SharedBackgroundEffectsPanel,
  type BackgroundEffectsPanelProps,
} from '@weldsuite/weldmeet-ui';
import { getRuntimeConfig } from '@/lib/runtime-config';

export function BackgroundEffectsPanel(props: Readonly<BackgroundEffectsPanelProps>) {
  return <SharedBackgroundEffectsPanel {...props} stockImages={props.stockImages ?? !getRuntimeConfig()} />;
}
