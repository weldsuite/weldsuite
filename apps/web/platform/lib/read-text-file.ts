/**
 * Decodes an uploaded text file the way FileReader.readAsText does: a UTF-16
 * byte-order mark (Excel "Unicode Text" and some bank exports) selects UTF-16,
 * anything else is UTF-8. `Blob.text()` alone always assumes UTF-8.
 */
export function decodeText(bytes: Uint8Array): string {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  // TextDecoder strips the byte-order mark by default.
  return new TextDecoder(encoding).decode(bytes);
}

export function readTextFile(file: Blob): Promise<string> {
  return file.arrayBuffer().then((buffer) => decodeText(new Uint8Array(buffer)));
}
