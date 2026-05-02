import { defineConfig } from 'tsup'

export default defineConfig([
  // Library — what `import { Voight } from '@voightxyz/sdk'` resolves to
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2022',
    minify: false,
  },
  // CLI — what `npx -y @voightxyz/sdk setup|hook` invokes
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: false,
    target: 'es2022',
    minify: false,
    banner: { js: '#!/usr/bin/env node' },
  },
])
