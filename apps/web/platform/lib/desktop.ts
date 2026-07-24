import type { WeldsuiteDesktopApi } from '../types/weldsuite-desktop';

export function getDesktop(): WeldsuiteDesktopApi | null {
  if (typeof window === 'undefined') return null;
  return window.weldsuiteDesktop ?? null;
}

export function isDesktop(): boolean {
  return getDesktop() !== null;
}
