import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

import { prerender } from './prerender/plugin.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // A private key in a browser bundle would be public the moment it ships.
  if (env.VITE_WELDCOMMERCE_KEY?.trim().startsWith('wcs_')) {
    throw new Error('VITE_WELDCOMMERCE_KEY is a private key (wcs_…). This shop runs in the browser: use a publishable key (wcp_…).');
  }
  return {
    server: { port: 3032 },
    preview: { port: 3032 },
    plugins: [tailwindcss(), react(), prerender(env)],
  };
});
