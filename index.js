// dshx-plugin-hub — host half.
//
// Everything this plugin does happens in the browser (client.js). The host
// half exists only so the profile's cordis.patch.yml has a plugin to mount,
// which is the reliable way to get a dshx-* package loaded (MAINTENANCE.md).

/** Stable Cordis plugin name. */
export const name = 'dshx-plugin-hub'

/** Nothing to do on the host. */
export function apply() {}
