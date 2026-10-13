/**
 * Database fixtures for tests that run against pglite (tenant) and the pglite
 * master DB. They live in the domain package, which the other workers' tests
 * share; used only by `*.test.ts`, never imported by worker code.
 */

export * from '@weldsuite/reach-domain/testing/account';
