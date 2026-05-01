#!/usr/bin/env node
/**
 * @choirmaster/cli bin entry. Compiled to dist/cli.js with shebang preserved
 * and chmod +x applied via the postbuild script. The library main() lives
 * in ./index.ts so callers can also import { main } from '@choirmaster/cli'.
 */
import { main } from './index.js'

main(process.argv)
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
