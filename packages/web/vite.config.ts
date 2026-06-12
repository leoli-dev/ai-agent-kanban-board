import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
