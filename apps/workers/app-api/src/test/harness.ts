/**
 * Test harness for app-api unit + integration tests. Lives in
 * @weldsuite/worker-kit/testing so module workers share it; this re-export
 * keeps existing imports working. For real-PostgreSQL tests see ./pglite.ts.
 */

export {
  createMockDb,
  createTestApp,
  permissions,
  type CreateTestAppOptions,
  type TestContext,
} from '@weldsuite/worker-kit/testing';
