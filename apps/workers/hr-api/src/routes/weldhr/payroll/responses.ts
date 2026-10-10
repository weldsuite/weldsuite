/**
 * Binary responses of the payroll routes: PDFs and generated files, always
 * as attachments (the employee and the back office save them; nothing here
 * is meant to render inline).
 */

import { attachment } from '../../../services/weldhr/payroll/format';

const SECURITY_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function pdfResponse(bytes: Uint8Array, fileName: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': attachment(fileName), ...SECURITY_HEADERS },
  });
}

export function generatedFileResponse(file: { fileName: string; contentType: string; content: string }): Response {
  return new Response(file.content, {
    status: 200,
    headers: { 'Content-Type': file.contentType, 'Content-Disposition': attachment(file.fileName), ...SECURITY_HEADERS },
  });
}

export function objectResponse(object: { body: ReadableStream | null }, fileName: string, contentType: string): Response {
  return new Response(object.body, {
    status: 200,
    headers: { 'Content-Type': contentType, 'Content-Disposition': attachment(fileName), ...SECURITY_HEADERS },
  });
}
