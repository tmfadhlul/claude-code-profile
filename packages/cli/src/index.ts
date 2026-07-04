#!/usr/bin/env node
import { buildProgram, makeContext } from './context.js'

buildProgram(makeContext()).parseAsync(process.argv).catch((e: Error) => {
  if ((e as any).code?.startsWith?.('commander.')) process.exit(1)
  console.error(`error: ${e.message}`)
  process.exit(1)
})
