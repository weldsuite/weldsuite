// Extensionless relative re-exports, matching every other @weldsuite/* package
// (see packages/core/email/src/index.ts). The `.js` extensions these used to
// carry broke Turbopack resolution in the Next.js consumers — the package ships
// raw TS and there is no emitted `resend.js` to resolve against.
export * from './resend';
export * from './ics';
