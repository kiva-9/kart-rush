import { defineConfig } from 'vite';

/**
 * OFFLINE_BUILD=1 produces one self-contained classic script instead of ES
 * modules, so the result can be inlined into a single HTML file and opened from
 * the filesystem (file://). ES modules are blocked by CORS on file://, which is
 * why the normal build cannot just be double-clicked.
 */
const offline = process.env.OFFLINE_BUILD === '1';

export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    outDir: offline ? 'dist-offline' : 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 12000,
    // Never preload chunks: an inlined classic script has nothing to preload.
    modulePreload: false,
    rollupOptions: offline
      ? {
          output: {
            // A single inline-able chunk, no code splitting, no manifest import
            // (unsupported in iife output), stable names for the inliner.
            format: 'iife',
            inlineDynamicImports: true,
            entryFileNames: 'game.js',
            assetFileNames: 'game.[ext]',
            manualChunks: undefined,
          },
        }
      : {
          output: {
            manualChunks: {
              three: ['three'],
            },
          },
        },
  },
});
