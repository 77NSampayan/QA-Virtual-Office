import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // one copy of React, always
  resolve: { dedupe: ['react', 'react-dom'] },
  // An occasional minified build came out different and broken (the page failed to start). Identifier renaming is the
  // step that varied, so it is left off: the bundle is a little larger and, being served from this computer, loads as fast.
  esbuild: { minifyIdentifiers: false },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
