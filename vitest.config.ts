import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests live next to source-mirror layout: tests/unit/<file>.test.ts
    // mirrors src/<file>.ts. Run with `npm run test`.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
})
