import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const requiredConfig = [
    'VITE_ENTRA_TENANT_ID',
    'VITE_ENTRA_CLIENT_ID',
    'VITE_ENTRA_AUTHORITY_HOST',
    'VITE_ENTRA_REDIRECT_URI',
    'VITE_ENTRA_POST_LOGOUT_REDIRECT_URI',
    'VITE_PORT',
  ];
  const missingConfig = requiredConfig.filter((name) => !env[name]);
  if (missingConfig.length) {
    throw new Error(`Missing ${missingConfig.join(', ')} in react-todo-client/.env`);
  }

  const port = Number(env.VITE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('VITE_PORT must be an integer between 1 and 65535');
  }

  return {
    plugins: [react()],
    server: { port },
  };
});
