import { defineConfig } from 'vite';

// Project is deployed to GitHub Pages at https://<user>.github.io/keygen/
// so assets must resolve under the /keygen/ subpath in production.
export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/keygen/' : '/',
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
