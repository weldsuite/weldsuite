import { GalleryHorizontalEnd, LayoutGrid, PanelRight, User } from 'lucide-react';
import { toast } from 'sonner';

/** Bits the desktop "More options" menu and the mobile sheet both use. */

export const LAYOUT_OPTIONS = [
  { value: 'grid', label: 'Grid', icon: LayoutGrid },
  { value: 'spotlight', label: 'Spotlight', icon: User },
  { value: 'speaker', label: 'Speaker', icon: GalleryHorizontalEnd },
  { value: 'sidebar', label: 'Sidebar', icon: PanelRight },
] as const;

/** Pauses or resumes the recording and confirms it with a toast. */
export function toggleRecordingPause(paused: boolean, pause?: () => void, resume?: () => void): void {
  if (paused) {
    resume?.();
    toast.success('Recording resumed');
  } else {
    pause?.();
    toast('Recording paused');
  }
}

/** Stops the recording and tells the user where it ends up. */
export function stopRecordingWithToast(stop?: () => void): void {
  stop?.();
  toast('Recording stopped. It will be available shortly.');
}
