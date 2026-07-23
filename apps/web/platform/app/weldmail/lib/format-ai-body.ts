/**
 * Ensures AI-generated email body has proper HTML paragraph structure.
 * Greeting, body paragraphs, and closing each get their own <p> tag,
 * with a trailing empty line.
 */
export function formatAiBody(body: string): string {
  let html = body;
  if (!/<p[\s>]/i.test(html)) {
    // Convert plain text with newlines to HTML paragraphs
    html = html
      .split(/\n\s*\n/)
      .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }
  // Always add an empty line at the end
  if (!html.endsWith('<p><br></p>')) {
    html += '<p><br></p>';
  }
  return html;
}
