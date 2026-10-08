/** Browser helpers for handing a PDF to the person: show it, or send it to the printer. */

export function pdfBlob(bytes: Uint8Array): Blob {
  // Copy into a plain ArrayBuffer so the Blob never views a shared buffer.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: 'application/pdf' });
}

/**
 * Opens the print dialog for a PDF through a hidden frame, so the screen the
 * person is on stays as it is. The frame and the object URL are removed once
 * the dialog had time to open.
 */
export function printPdfBytes(bytes: Uint8Array): void {
  const url = URL.createObjectURL(pdfBlob(bytes));
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.setAttribute('aria-hidden', 'true');

  const cleanup = () => {
    frame.remove();
    URL.revokeObjectURL(url);
  };
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      // The print dialog is modal in most browsers; give it a minute before the PDF goes away.
      window.setTimeout(cleanup, 60_000);
    }
  };
  frame.src = url;
  document.body.appendChild(frame);
}
