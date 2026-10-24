/** Colours the canvas grid draws with, read from the app's CSS tokens so dark mode follows. */
export interface GridTheme {
  cellBackground: string;
  text: string;
  gridline: string;
  headerBackground: string;
  headerText: string;
  headerBorder: string;
  headerSelected: string;
  headerSelectedText: string;
  selectionBorder: string;
  selectionFill: string;
  freezeLine: string;
  dark: boolean;
}

/** Colours formula references are outlined in while editing, in order of appearance. */
export const REFERENCE_COLORS = ['#1a73e8', '#e8710a', '#9334e6', '#188038', '#d93025', '#007b83', '#b06000'];

export function readGridTheme(el: Element): GridTheme {
  const css = getComputedStyle(el);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = !!el.closest('.dark');
  const accent = dark ? '#709ff5' : '#1a73e8';
  return {
    cellBackground: token('--background', '#ffffff'),
    text: token('--foreground', '#111111'),
    gridline: dark ? '#34373d' : '#e2e3e3',
    headerBackground: token('--muted', '#f8f9fa'),
    headerText: token('--muted-foreground', '#5f6368'),
    headerBorder: token('--border', '#dadce0'),
    headerSelected: dark ? '#2b3a55' : '#d3e3fd',
    headerSelectedText: dark ? '#ffffff' : '#0b57d0',
    selectionBorder: accent,
    selectionFill: dark ? 'rgba(112, 159, 245, 0.16)' : 'rgba(26, 115, 232, 0.10)',
    freezeLine: dark ? '#4a4f57' : '#c4c7c5',
    dark,
  };
}
