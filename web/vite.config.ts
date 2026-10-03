import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The server (port 3000) serves web/dist, so the phone needs only the one tunnel.
// `npm run dev` is for desk work: it proxies the API and the WebSocket to the server.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
  server: {
    fs: { allow: ['..'] },
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/phone': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
