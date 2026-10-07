import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  root: here,
  publicDir: path.join(here, 'public'),
  plugins: [react()],
  build: {
    outDir: path.join(here, '..', '..', 'dist', 'shell'),
    emptyOutDir: true,
    // Each app's screens are their own file, fetched only when that app is on and opened.
    rollupOptions: { output: { chunkFileNames: 'assets/[name]-[hash].js' } },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080', '/auth': 'http://localhost:8080', '/m': 'http://localhost:8080', '/mcp': 'http://localhost:8080', '/live': { target: 'ws://localhost:8080', ws: true }, '/files': 'http://localhost:8080', '/alerts': 'http://localhost:8080' },
  },
});
