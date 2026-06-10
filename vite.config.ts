import { defineConfig } from 'vite';

// Relative base so the built site works from any path — the domain root, a
// subfolder on your own web server, or the /keygen/ subpath on GitHub Pages.
export default defineConfig({
  base: './',
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
