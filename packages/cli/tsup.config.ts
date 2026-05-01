import { defineConfig } from 'tsup'

/**
 * Bundle the CLI into a single self-contained package. The two internal
 * workspace packages (@choirmaster/core, @choirmaster/agent-claude) are
 * inlined so users install one thing, not three. Real npm dependencies
 * (tsx, node built-ins) stay external.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  // Inline the type definitions of the internal workspace packages into
  // the published dts. Without `resolve`, tsup leaves `export * from
  // '@choirmaster/core'` lines verbatim - which would fail to resolve
  // for end users since those packages aren't published.
  dts: {
    resolve: true,
  },
  clean: true,
  splitting: false,
  sourcemap: true,
  shims: false,
  // Bundle all `@choirmaster/*` internal packages into the runtime output.
  // Anything not listed here defaults to "external" (left as a runtime
  // import) when it appears in `dependencies` of package.json.
  noExternal: [/^@choirmaster\//],
})
