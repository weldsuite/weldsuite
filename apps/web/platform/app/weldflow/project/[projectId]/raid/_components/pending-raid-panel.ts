import { atom } from 'jotai';

/**
 * A RAID item whose panel opens once its sub-tab is on screen. Moving to
 * another page closes every panel (the object-panel host does that on each
 * pathname change), so the panel cannot be opened before the move: the RAID
 * layout opens it once the new sub-tab shows and the old panels are gone.
 */
export const pendingRaidPanelAtom = atom<{ path: string; id: string } | null>(null);
