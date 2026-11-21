/** Whether the page runs inside an iframe. A cross-origin parent throws on access, which also means framed. */
export function isFramed(win: Window = window): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}
