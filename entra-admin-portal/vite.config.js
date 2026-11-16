import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev:   npm run dev      -> http://localhost:5174 (proxies /api to the mock server on :8080)
// Build: npm run build    -> writes to ../mock-entra-server/portal, which the mock server serves at https://localhost:8080/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // URL lets the dev server proxy to an https (self-signed or mkcert certificates are accepted)
    proxy: { '/api': { target: process.env.PUBLIC_URL, secure: false } },
  },
  build: {
    outDir: '../mock-entra-server/portal',
    emptyOutDir: true,
  },
});
