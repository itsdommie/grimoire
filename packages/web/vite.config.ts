import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: { '/api': process.env.GRIMOIRE_API ?? 'http://127.0.0.1:3001' },
  },
});
