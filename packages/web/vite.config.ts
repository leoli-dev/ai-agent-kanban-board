import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Single-user, self-hosted app served over localhost/LAN: one ~200 kB-gzip
  // bundle loads instantly, so the default 500 kB warning isn't meaningful here.
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:5713', changeOrigin: true },
      '/uploads': { target: 'http://localhost:5713', changeOrigin: true },
      '/ws': { target: 'ws://localhost:5713', ws: true },
    },
  },
});
