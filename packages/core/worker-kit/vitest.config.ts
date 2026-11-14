import { defineConfig } from 'vitest/config';

// Vitest's defaults. scripts/sonar-coverage.mjs reports coverage only for a
// workspace with a Vitest config, so this one exists for the SonarQube scan.
export default defineConfig({});
