/**
 * Paragraph spacing for the mail composers' contentEditable editors.
 *
 * Tailwind's preflight zeroes every margin, so a `<p>` pasted from another
 * mail client or a document showed no gap in the editor. Recipients (and our
 * own reader, see `isolated-html-content.tsx`) render the same `<p>` with a
 * 1em gap, so blank lines added by hand to make the editor look right came out
 * doubled once sent. These rules match the reader's: `p { margin: 0 0 1em }`,
 * none after the last one, and none on Word/Outlook's `MsoNormal` paragraphs.
 * Inline `margin` styles on pasted markup still win, as they do for recipients.
 */
export const MAIL_EDITOR_PARAGRAPH_CLASSES =
  '[&_p]:mb-[1em] [&_p:last-child]:mb-0 [&_.MsoNormal]:m-0';
