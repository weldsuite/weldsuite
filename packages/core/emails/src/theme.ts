/**
 * Design tokens of every system email. Restyling the mail is editing this
 * file: components read colors, sizes and spacing from here and nowhere else.
 *
 * Email clients only honor inline styles, so these are plain values (no CSS
 * variables), and colors are hex (Outlook ignores rgba/oklch).
 */
export const theme = {
  color: {
    /** Page background. White: no card floating on grey. */
    page: '#ffffff',
    /** Headings, emphasis, primary button. */
    ink: '#09090b',
    /** Body copy. */
    text: '#3f3f46',
    /** Labels, secondary copy. */
    muted: '#71717a',
    /** Footer, struck-through values. */
    subtle: '#a1a1aa',
    /** Hairlines. */
    border: '#e4e4e7',
    /** Secondary button, code block. */
    surface: '#f4f4f5',
    /** Default accent (buttons) when the brand has none. Workspace colors replace it. */
    accent: '#09090b',
    onAccent: '#ffffff',
  },
  font: {
    family:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, 'Helvetica Neue', Arial, sans-serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  },
  /** Font sizes in px. */
  size: {
    heading: 24,
    body: 15,
    small: 14,
    tiny: 12,
    code: 30,
  },
  lineHeight: {
    tight: 1.25,
    body: 1.6,
  },
  /** Corner radii in px. */
  radius: {
    button: 6,
    block: 8,
  },
  /** Spacing in px. */
  space: {
    pageY: 48,
    pageX: 24,
    /** Between blocks of content. */
    block: 24,
    /** Between a heading or paragraph and what follows. */
    text: 16,
  },
  /** Width of the content column in px. */
  width: 520,
  logo: {
    /** 2x PNG of the WeldSuite wordmark, served by the platform's static assets. */
    url: 'https://app.weldsuite.org/email/weldsuite-logo.png',
    width: 110,
    height: 20,
  },
  /** Rendered height of a workspace logo in the header, in px. */
  workspaceLogoHeight: 28,
  links: {
    weldsuite: 'https://weldsuite.org',
  },
} as const;

export type Theme = typeof theme;
