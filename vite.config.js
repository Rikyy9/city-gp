import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  // relative paths: the build works from any folder (itch.io, GitHub Pages sub-paths, Netlify…)
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 8765, strictPort: true },
  preview: { port: 8766 },
  build: {
    outDir: 'dist',
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'], leaflet: ['leaflet'] },
      },
    },
  },
});
