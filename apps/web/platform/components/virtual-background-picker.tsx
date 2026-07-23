// Re-export shim — the canonical implementation lives in
// `packages/design/weldmeet-ui/src/components/background-effects-panel.tsx`. This
// shim is kept so existing platform imports (`@/components/virtual-background-picker`)
// continue to resolve while the meeting-portal app uses the same shared
// component. Edit the shared file to change behavior — both apps stay in sync.
export { BackgroundEffectsPanel } from '@weldsuite/weldmeet-ui';
;
