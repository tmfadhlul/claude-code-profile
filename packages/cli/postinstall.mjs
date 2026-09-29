// Only global CLI installs change the user's Claude configuration. Workspace installs
// (including contributors running npm install) leave their home directory untouched.
if (process.env.npm_config_global === 'true') {
  try {
    const { installDefaultStatusline } = await import('./dist/statusline-install.js')
    const changed = await installDefaultStatusline(process.env.HOME ?? process.env.USERPROFILE)
    if (changed.length) process.stdout.write(`ccprofiles: installed default Claude statusline in ${changed.length} profile(s)\n`)
  } catch (e) {
    process.stderr.write(`ccprofiles: statusline setup failed: ${e.message}\n`)
    process.exitCode = 1
  }
}
