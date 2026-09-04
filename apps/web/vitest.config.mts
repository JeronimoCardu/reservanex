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
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
