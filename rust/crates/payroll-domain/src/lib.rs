//! WeldSuite's payroll engines (NL and US), pay periods, payment files and
//! payslip documents: `@weldsuite/payroll-domain` (`packages/domains/payroll`).
//! Pure functions; no database.
//!
//! hr-api's payroll services (`weldsuite-hr`) use it today; books-api's
//! payroll routes will once WeldBooks is ported. Every calculation answers
//! exactly as the TypeScript package does: the tests run vectors the
//! TypeScript code wrote (`tests/fixtures`).
