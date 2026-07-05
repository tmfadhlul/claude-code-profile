import { discoverProfiles, planApply, resolveSettingsEnv, type ApplyAction, type Manifest, type SecretsStore } from 'ccprofiles-core'
import { secretsStore } from './commands/secrets.js'
import type { CliContext } from './context.js'

/** Plan apply actions with settingsEnv secret refs resolved from the secrets store (lazily opened). */
export async function planActions(ctx: CliContext, m: Manifest): Promise<ApplyAction[]> {
  let store: SecretsStore | null = null
  const resolved = await resolveSettingsEnv(m, async name => {
    store ??= await secretsStore(ctx)
    return store.get(name)
  })
  return planApply(m, await discoverProfiles(ctx.home), ctx.platform, resolved)
}

/** Resolve settingsEnv secrets without planning — cheap validation that refs exist. */
export async function planActionsPreflight(ctx: CliContext, m: Manifest): Promise<void> {
  let store: SecretsStore | null = null
  await resolveSettingsEnv(m, async name => {
    store ??= await secretsStore(ctx)
    return store.get(name)
  })
}
