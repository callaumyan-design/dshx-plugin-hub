// Install dshx-plugin-hub into the desktop profile (the three registrations
// from MAINTENANCE.md). Run only while DSH is NOT running — it writes
// cordis.patch.yml, which DSH also writes at runtime.
//
//   node install-profile.mjs            # install
//   node install-profile.mjs --dry-run  # show what would change
//
// Backups: <file>.bak-plugin-hub-<stamp> next to package.json and cordis.patch.yml.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const NAME = 'dshx-plugin-hub'
const SPEC = 'file:F:/ds/dsh/dshx-plugins/dshx-plugin-hub'
const AFTER_BUNDLE = 'dshmarket'
const FILES = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'README.md']
const here = path.dirname(fileURLToPath(import.meta.url))
const PROFILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop')
const dry = process.argv.includes('--dry-run')
const log = (...a) => console.log(dry ? '[dry-run]' : '', ...a)

// 0. DSH must be stopped.
const running = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH', { encoding: 'utf8' })
if (/DeepSeek Harness\.exe/i.test(running)) {
  console.error('DSH is running — quit it first (tray → 退出).')
  if (!dry) process.exit(2)
}

const d = new Date()
const p2 = (n) => String(n).padStart(2, '0')
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
const pkgPath = path.join(PROFILE, 'package.json')
const patchPath = path.join(PROFILE, 'cordis.patch.yml')
const hasBom = (p) => { const b = fs.readFileSync(p); return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf }
const stripBom = (p) => { if (hasBom(p)) { fs.writeFileSync(p, fs.readFileSync(p).subarray(3)); log('stripped BOM', p) } }

for (const p of [pkgPath, patchPath]) if (hasBom(p)) throw new Error('BOM already present before install: ' + p)

// 1. Backups.
for (const p of [pkgPath, patchPath]) {
  const to = `${p}.bak-plugin-hub-${stamp}`
  log('backup', path.basename(p), '->', path.basename(to))
  if (!dry) fs.copyFileSync(p, to)
}

// 2. node_modules copy (break pnpm hard links before writing).
const target = path.join(PROFILE, 'node_modules', NAME)
log('copy', FILES.join(', '), '->', target)
if (!dry) {
  fs.mkdirSync(target, { recursive: true })
  for (const f of FILES) {
    const to = path.join(target, f)
    if (fs.existsSync(to) && fs.statSync(to).nlink > 1) fs.unlinkSync(to)
    fs.copyFileSync(path.join(here, f), to)
    if (fs.statSync(to).nlink !== 1) throw new Error('still hard-linked: ' + to)
  }
}

// 3. package.json: dependency + bundle right after dshmarket.
const text = fs.readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(text)
pkg.dependencies[NAME] = SPEC
const bundles = pkg.dsh.profile.bundles
if (!bundles.includes(NAME)) {
  const at = bundles.indexOf(AFTER_BUNDLE)
  bundles.splice(at === -1 ? bundles.length : at + 1, 0, NAME)
}
const nextText = JSON.stringify(pkg, null, 2) + '\n'
log('package.json bundles:', bundles.slice(Math.max(0, bundles.indexOf(NAME) - 1), bundles.indexOf(NAME) + 2).join(' → '))
if (!dry && nextText !== text) fs.writeFileSync(pkgPath, nextText)

// 4. cordis.patch.yml: explicit mount entry.
const yaml = createRequire(path.join(PROFILE, 'package.json'))('js-yaml')
const patchText = fs.readFileSync(patchPath, 'utf8')
const before = yaml.load(patchText)
if (!before.some((e) => e && e.id === NAME)) {
  const sep = patchText.endsWith('\n') ? '' : '\n'
  const nextPatch = `${patchText}${sep}- id: ${NAME}\n  name: ${NAME}\n`
  const after = yaml.load(nextPatch)
  if (after.length !== before.length + 1 || after.at(-1).id !== NAME || after.at(-1).name !== NAME) throw new Error('patch append did not parse as expected')
  log('cordis.patch.yml: append - id/name', NAME)
  if (!dry) fs.writeFileSync(patchPath, nextPatch)
} else log('cordis.patch.yml: entry already present')

// 5. Post-checks.
if (!dry) {
  for (const p of [pkgPath, patchPath]) stripBom(p)
  JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const doc = yaml.load(fs.readFileSync(patchPath, 'utf8'))
  console.log('dshx-* in cordis.patch.yml:', doc.filter((e) => String(e?.id || '').startsWith('dshx-')).map((e) => e.id).join(', '))
  console.log('package.json head bytes:', [...fs.readFileSync(pkgPath).subarray(0, 3)].map((x) => x.toString(16)).join(' '))
}

// 6. Stale lock from the interrupted update (only if its PID is gone).
const lock = path.join(PROFILE, 'package.json.lock')
if (fs.existsSync(lock)) {
  const pid = Number(fs.readFileSync(lock, 'utf8').trim())
  let alive = false
  try { process.kill(pid, 0); alive = true } catch { /* gone */ }
  if (alive) console.log(`lock PID ${pid} is alive — leaving package.json.lock`)
  else { log(`remove stale package.json.lock (PID ${pid} gone)`); if (!dry) fs.unlinkSync(lock) }
}
console.log(dry ? 'dry run done' : 'installed')
