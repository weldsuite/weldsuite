// Re-export shim — the canonical implementation lives in
// `packages/design/weldmeet-ui/src/hooks/use-virtual-background.ts`. Edit there to
// change behavior so the platform and meeting-portal apps stay in sync.
export {
  useVirtualBackground,
  useVirtualBackgroundPreference,
  
} from '@weldsuite/weldmeet-ui';
export type {
  VirtualBackgroundType,
  
} from '@weldsuite/weldmeet-ui';
