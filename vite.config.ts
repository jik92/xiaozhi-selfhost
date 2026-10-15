import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5178, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:18080', '/events': { target: 'http://127.0.0.1:18080', ws: true } } },
  build: { chunkSizeWarningLimit: 1600 },
});
