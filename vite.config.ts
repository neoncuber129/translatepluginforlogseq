import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  build: {
    target: 'esnext',
    minify: 'esbuild',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // UI page rendered inside the plugin iframe
        index: resolve(__dirname, 'index.html'),
      },
    },
  },
  optimizeDeps: {
    include: ['@logseq/libs', 'jszip'],
  },
});
