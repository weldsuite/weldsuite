/** Minimal ANSI color helpers — no dependencies, honours NO_COLOR and non-TTY output. */

const colorEnabled = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;

function wrap(open: number, close: number): (text: string) => string {
  return (text: string): string => (colorEnabled ? `\u001b[${open}m${text}\u001b[${close}m` : text);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);

export function info(message: string): void {
  console.log(message);
}

export function success(message: string): void {
  console.log(`${green('✔')} ${message}`);
}

export function warn(message: string): void {
  console.warn(`${yellow('!')} ${message}`);
}

export function error(message: string): void {
  console.error(`${red('✖')} ${message}`);
}

export function heading(message: string): void {
  console.log(bold(message));
}

/** Render a padded plain-text table. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const renderRow = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ');
  const lines = [
    bold(renderRow(headers)),
    dim(renderRow(widths.map((width) => '-'.repeat(width)))),
    ...rows.map((row) => renderRow(row)),
  ];
  return lines.join('\n');
}
