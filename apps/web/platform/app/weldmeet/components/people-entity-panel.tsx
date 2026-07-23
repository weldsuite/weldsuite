// Re-export shim — the canonical implementation lives in
// `packages/design/weldmeet-ui/src/components/people-entity-list-panel.tsx`. Both the
// platform and the meeting-portal consume the same shared component so the
// "People" right-panel renders identically in both apps. Edit the shared file
// to change behavior — both update.
export { PeopleEntityListPanel } from '@weldsuite/weldmeet-ui';
export type { PeopleEntityListPanelProps } from '@weldsuite/weldmeet-ui';
