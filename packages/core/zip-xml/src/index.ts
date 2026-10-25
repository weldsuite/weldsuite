/**
 * @weldsuite/zip-xml: the ZIP container and the small XML toolkit that Office
 * Open XML files (.xlsx, .docx) are read and written with.
 *
 * Pure TypeScript with no dependencies, shared by @weldsuite/sheets-engine and
 * @weldsuite/docs-engine so both parse files the same, defensive way.
 */

export { ZipError, crc32, decodeText, openZip, writeZip } from './zip';
export type { ZipErrorCode, ZipFile, ZipLimits, ZipReader } from './zip';
export {
  XML_HEADER,
  XmlError,
  attrs,
  child,
  childrenOf,
  decodeEntities,
  esc,
  isXmlUnsafe,
  localName,
  parseXml,
  scanXml,
} from './xml';
export type { XmlAttrs, XmlElement, XmlHandler } from './xml';
