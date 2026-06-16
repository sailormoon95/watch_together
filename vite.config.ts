import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/watch/',
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      '/watch/api': 'http://127.0.0.1:3000',
      '/watch/ws': {
        target: 'ws://127.0.0.1:3000',
        ws: true
      }
    }
  }
});
