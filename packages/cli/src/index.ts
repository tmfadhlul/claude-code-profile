#!/usr/bin/env node
import { buildProgram, makeContext } from './context.js'

buildProgram(makeContext()).parseAsync(process.argv).catch((e: Error) => {
  // commander (with exitOverride) throws for --help/--version too; honor its exit code
  // (0 for help/version display) instead of forcing failure.
  const cmd = e as { code?: string; exitCode?: number }
  if (cmd.code?.startsWith?.('commander.')) process.exit(typeof cmd.exitCode === 'number' ? cmd.exitCode : 1)
  console.error(`error: ${e.message}`)
  process.exit(1)
})
