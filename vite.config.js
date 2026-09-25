import { defineConfig } from 'vite';

export default defineConfig({
  // public/ holds this site's JS and CSS source, so Vite must process it instead of
  // copying it untouched as its default static-asset folder
  publicDir: false,
});
