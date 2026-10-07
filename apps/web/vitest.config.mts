import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Mirrors tsconfig.json's "@/*" → "./src/*" path alias — needed because
// several src files (e.g. Route Handlers under src/app/api) import via "@/…",
// and Vitest does not read tsconfig "paths" on its own.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(import.meta.dirname, './src') },
      // The TUS uploader (src/lib/property-videos/resumable-upload.ts) only
      // runs in the browser, where Next bundles tus-js-client's "browser"
      // build. Under environment 'node' Vitest would pick the Node build
      // instead, which only accepts Buffer/Readable (no Blob/File) — so tests
      // pin the same browser build that actually ships.
      {
        find: /^tus-js-client$/,
        replacement: path.resolve(import.meta.dirname, './node_modules/tus-js-client/lib.esm/browser/index.js'),
      },
    ],
  },
})
