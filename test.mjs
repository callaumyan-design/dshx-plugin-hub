// dshx-plugin-hub tests.
//
// Runs client.js next to the REAL rc.5 tab container
// (test-fixtures/settings-plugins.rc5.client.js, served by DSH 0.2.1-rc.5) on
// a slot ledger that copies rc.5 SlotCore semantics: register copies options
// into a fresh plain object, list slots refuse a duplicate id at the same
// priority, every mutation bumps `version` synchronously and listeners run in
// a microtask. dshmarket is a stand-in built from its 1.66.35 source
// (src/client/index.ts + section-gate.ts).
//
//   node test.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const flush = () => new Promise((r) => setTimeout(r, 0))

// ---------------------------------------------------------------- slot core
function createCore() {
  const records = new Map()
  const record = (k) => {
    let r = records.get(k)
    if (!r) records.set(k, r = { entries: Object.freeze([]), spec: undefined, version: 0, listeners: new Set(), waiters: [] })
    return r
  }
  let scheduled = false
  const dirty = new Set()
  const markDirty = (r) => {
    r.version += 1
    dirty.add(r)
    if (!scheduled) {
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        const list = [...dirty]; dirty.clear()
        for (const x of list) for (const fn of [...x.listeners]) fn()
      })
    }
  }
  return {
    declare(name, spec) { const r = record(name); r.spec = spec; markDirty(r); for (const w of r.waiters.splice(0)) w() },
    declared: (name) => record(name).spec !== undefined,
    waitDeclared(name, fn) { record(name).waiters.push(fn) },
    register(o, component) {
      const r = record(o.name)
      if (r.spec?.kind === 'list') {
        if (o.id === undefined) throw new Error('list slot requires id')
        if (r.entries.find((p) => p.options.id === o.id && (p.options.priority ?? 0) === (o.priority ?? 0))) {
          throw new Error(`list slot "${o.name}" already has an entry with id "${o.id}"`)
        }
      }
      const entry = {
        component,
        options: {
          ...(o.key !== undefined ? { key: o.key } : {}),
          ...(o.id !== undefined ? { id: o.id } : {}),
          ...(o.order !== undefined ? { order: o.order } : {}),
          ...(o.label !== undefined ? { label: o.label } : {}),
          ...(o.priority !== undefined ? { priority: o.priority } : {}),
        },
        ...(o.inject !== undefined ? { inject: o.inject } : {}),
        ...(o.locale !== undefined ? { locale: o.locale } : {}),
      }
      const next = [...r.entries, entry]
      next.sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0) || (a.options.order ?? 0) - (b.options.order ?? 0))
      r.entries = next
      markDirty(r)
      if (o.children) for (const [k, spec] of Object.entries(o.children)) this.declare(k, spec)
      return () => {
        if (!r.entries.includes(entry)) return
        r.entries = r.entries.filter((e) => e !== entry)
        markDirty(r)
      }
    },
    entries: (k) => records.get(k)?.entries ?? [],
    getVersion: (k) => records.get(k)?.version ?? 0,
    subscribe(k, fn) { const r = record(k); r.listeners.add(fn); return () => r.listeners.delete(fn) },
  }
}

// ---------------------------------------------------------------- locale
function createLocale() {
  const dicts = new Map()
  const listeners = new Set()
  let current = 'zh'
  let revision = 0
  return {
    register(ns, d) {
      if (dicts.has(ns)) throw new Error(`locale namespace "${ns}" already registered`)
      dicts.set(ns, d)
      revision++
      return () => { dicts.delete(ns); revision++ }
    },
    bind: (ns) => (key) => dicts.get(ns)?.[current]?.[key] ?? key,
    getSnapshot: () => ({ revision }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    setLocale(l) { current = l; revision++; for (const fn of [...listeners]) fn() },
  }
}

// ---------------------------------------------------------------- fibers
function createWorld() {
  const core = createCore()
  const locale = createLocale()
  const services = new Map()
  const serviceWaiters = []

  function makeCtx(parent) {
    const disposers = []
    const children = []
    let active = true
    const ctx = {
      get active() { return active },
      effect(fn) {
        if (!active) throw new Error('inactive context')
        const off = fn()
        if (typeof off === 'function') disposers.push(off)
      },
      locale,
      slots: {
        register(o, c) {
          if (!active) throw new Error('inactive context')
          const off = core.register(o, c)
          disposers.push(off)
          return off
        },
        inject(name, fn) { if (core.declared(name)) fn(); else core.waitDeclared(name, () => { if (active) fn() }) },
        entries: (k) => core.entries(k),
        getVersion: (k) => core.getVersion(k),
        subscribe: (k, fn) => core.subscribe(k, fn),
      },
      provide(name, value) {
        services.set(name, value)
        disposers.push(() => { services.delete(name); for (const w of serviceWaiters) if (w.name === name) w.drop() })
        for (const w of serviceWaiters) if (w.name === name) w.fire()
      },
      inject(names, cb) {
        const [name] = names
        let child = null
        const w = {
          name,
          fire() { if (child || !active) return; child = makeCtx(ctx); child[name] = services.get(name); cb(child) },
          drop() { if (child) { child.dispose(); child = null } },
        }
        serviceWaiters.push(w)
        disposers.push(() => { w.drop(); serviceWaiters.splice(serviceWaiters.indexOf(w), 1) })
        if (services.has(name)) w.fire()
      },
      dispose() {
        if (!active) return
        for (const c of children.splice(0)) c.dispose()
        active = false
        for (const off of disposers.splice(0).reverse()) { try { off() } catch { /* like cordis */ } }
      },
    }
    if (parent) parent._children?.push(ctx)
    ctx._children = children
    return ctx
  }
  return { core, locale, services, makeCtx }
}

// ---------------------------------------------------------------- loaders
function loadBundle(file, requireMap) {
  let captured
  const sandbox = { window: { __ModuleLoader__: { load: (m) => { captured = m } } }, console }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file })
  return captured.factory((id) => {
    if (!(id in requireMap)) throw new Error('unexpected require ' + id)
    return requireMap[id]
  })
}

const reactStub = { useId: () => 'x', useRef: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {} }
const jsxStub = { jsx: () => null, jsxs: () => null, Fragment: 'f' }
const slotsModule = { resolveSlotLabel: (l) => (typeof l === 'function' ? l() : l) }

function loadHostTabs() {
  return loadBundle(path.join(here, 'test-fixtures', 'settings-plugins.rc5.client.js'), {
    react: reactStub, 'react/jsx-runtime': jsxStub, '@deepseek-ai/dsh-client-ui-slots': slotsModule,
  })
}
function loadHub() {
  return loadBundle(path.join(here, 'client.js'), {})
}

/** The settings dialog's root: declares settings.section, mounts the host's plugins page. */
function bootHost(world) {
  world.core.declare('settings.section', { kind: 'list', scope: 'root' })
  const hostCtx = world.makeCtx()
  loadHostTabs().apply(hostCtx)
  const section = world.core.entries('settings.section').find((e) => e.options.id === 'plugins')
  const hooks = section.inject().hooks.tabs
  // Host's own read-only inventory tab.
  hostCtx.slots.register({ name: 'settings.plugins.tab', id: 'all', order: 10, label: '插件列表' }, () => 'inventory')
  return { hostCtx, hooks }
}

/** dshmarket 1.66.35 stand-in: market service, own section via the gate, settings-card tab. */
function bootMarket(world) {
  const ctx = world.makeCtx()
  const t = (k) => ({ nav: '插件市场' })[k] ?? k
  // createSectionGate(register) — copied behaviour.
  let ready = false, wanted = true, removed = false, dispose = null
  const apply = () => {
    if (!ready) return
    const show = wanted && !removed
    if (show && dispose === null) { dispose = ctx.slots.register({ name: 'settings.section', id: 'market', order: 40, label: () => t('nav') }, () => 'market-section'); return }
    if (!show && dispose !== null) { const stop = dispose; dispose = null; stop() }
  }
  const rendered = { count: 0 }
  ctx.slots.inject('settings.section', () => { ready = true; apply() })
  ctx.provide('market', {
    version: 1,
    setSettingsVisible: (v) => { wanted = v; apply() },
    settingsVisible: () => dispose !== null,
    render: () => { rendered.count++; return { type: 'market-panel' } },
  })
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab', id: 'dsh-market', order: 60, label: () => t('nav'), locale: 'dsh-market',
  }, () => 'settings-card'))
  return { ctx, rendered }
}

function bootHubPlugin(world) {
  const ctx = world.makeCtx()
  const hub = loadHub()
  hub.apply(ctx)
  return { ctx, hub }
}

/** What the tab row shows, read the way useSyncExternalStore would. */
function tabRow(hooks) { return hooks.getSnapshot().map((r) => `${r.label}#${r.id}`) }
function sections(world) { return world.core.entries('settings.section').map((e) => e.options.id) }
function rawTabIds(world) { return world.core.entries('settings.plugins.tab').map((e) => e.options.id) }

// ---------------------------------------------------------------- tests
let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name) } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)) }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

const MERGED = ['插件市场#dshx-market-browse', '插件列表#all', '市场设置#dsh-market']

await test('host, market, hub: merged tabs and market section hidden', async () => {
  const w = createWorld(); const { hooks } = bootHost(w); bootMarket(w); bootHubPlugin(w); await flush()
  eq(tabRow(hooks), MERGED, 'tabs')
  eq(sections(w), ['plugins'], 'settings sections')
  eq(rawTabIds(w), ['dshx-market-browse', 'all', 'dsh-market'], 'raw tab entries (no placeholder left)')
})

await test('host, hub, market: same result when the market loads last', async () => {
  const w = createWorld(); const { hooks } = bootHost(w); bootHubPlugin(w); bootMarket(w); await flush()
  eq(tabRow(hooks), MERGED, 'tabs')
  eq(sections(w), ['plugins'], 'settings sections')
})

await test('hub and market before the settings slots exist', async () => {
  const w = createWorld(); bootHubPlugin(w); bootMarket(w); const { hooks } = bootHost(w); await flush()
  eq(tabRow(hooks), MERGED, 'tabs')
  eq(sections(w), ['plugins'], 'settings sections')
})

await test('a snapshot cached before the rename is refreshed', async () => {
  const w = createWorld(); const { hooks } = bootHost(w)
  let seen = null
  hooks.subscribe(() => { seen = tabRow(hooks) })
  bootMarket(w); await flush()
  eq(tabRow(hooks), ['插件列表#all', '插件市场#dsh-market'], 'before hub')
  bootHubPlugin(w); await flush()
  eq(seen, MERGED, 'what a subscribed reader sees')
})

await test('a reader notified before the rename still ends up with the new label', async () => {
  // The open settings page subscribed first, so its listener runs before the
  // hub's: it caches 「插件市场」 for dsh-market, then the hub renames. Only
  // the hub's refresh makes the page read again.
  const w = createWorld(); const { hooks } = bootHost(w)
  let seen = null
  hooks.subscribe(() => { seen = tabRow(hooks) })
  bootHubPlugin(w); bootMarket(w); await flush(); await flush()
  eq(seen, MERGED, 'what a subscribed reader sees')
})

await test('the dsh-market tab is renamed again after dshmarket re-registers it', async () => {
  const w = createWorld(); const { hooks } = bootHost(w); const m = bootMarket(w); bootHubPlugin(w); await flush()
  const entry = w.core.entries('settings.plugins.tab').find((e) => e.options.id === 'dsh-market')
  const off = w.core.register({ name: 'settings.plugins.tab', id: 'dsh-market', order: 60, priority: 1, label: () => '插件市场' }, () => null)
  await flush()
  eq(tabRow(hooks).filter((r) => r.endsWith('#dsh-market')), ['市场设置#dsh-market', '市场设置#dsh-market'], 'both entries renamed')
  off(); void entry; void m
})

await test('the browse tab renders market.render()', async () => {
  const w = createWorld(); bootHost(w); const m = bootMarket(w); bootHubPlugin(w); await flush()
  const browse = w.core.entries('settings.plugins.tab').find((e) => e.options.id === 'dshx-market-browse')
  eq(browse.component(), { type: 'market-panel' }, 'component output')
  eq(m.rendered.count, 1, 'render calls')
  eq(browse.options.order, 5, 'order')
})

await test('English locale relabels both hub tabs', async () => {
  const w = createWorld(); const { hooks } = bootHost(w); bootMarket(w); bootHubPlugin(w); await flush()
  w.locale.setLocale('en')
  eq(tabRow(hooks), ['Plugin market#dshx-market-browse', '插件列表#all', 'Market settings#dsh-market'], 'tabs')
})

await test('without dshmarket the hub changes nothing', async () => {
  const w = createWorld(); const { hooks } = bootHost(w); bootHubPlugin(w); await flush()
  eq(tabRow(hooks), ['插件列表#all'], 'tabs')
  eq(sections(w), ['plugins'], 'sections')
})

await test('unloading the hub restores the original layout', async () => {
  const w = createWorld(); const { hooks } = bootHost(w); bootMarket(w); const { ctx } = bootHubPlugin(w); await flush()
  ctx.dispose(); await flush()
  eq(tabRow(hooks), ['插件列表#all', '插件市场#dsh-market'], 'tabs')
  eq(sections(w), ['plugins', 'market'], 'market section is back')
})

await test('unloading dshmarket removes the hub tab', async () => {
  const w = createWorld(); const { hooks } = bootHost(w); const m = bootMarket(w); bootHubPlugin(w); await flush()
  m.ctx.dispose(); await flush()
  eq(tabRow(hooks), ['插件列表#all'], 'tabs')
  eq(sections(w), ['plugins'], 'sections')
})

const UNRENAMED = ['插件市场#dshx-market-browse', '插件列表#all', '插件市场#dsh-market']

await test('rename failure (ledger read throws) keeps the merge working', async () => {
  const w = createWorld(); const { hooks } = bootHost(w); bootMarket(w)
  const realEntries = w.core.entries
  let reads = 0
  w.core.entries = (k) => { if (k === 'settings.plugins.tab' && new Error().stack.includes('relabel')) { reads++; throw new Error('ledger moved') } return realEntries(k) }
  const warn = console.warn; console.warn = () => {}
  try { bootHubPlugin(w); await flush(); await flush() } finally { console.warn = warn; w.core.entries = realEntries }
  if (reads === 0) throw new Error('relabel never hit the failing read')
  eq(tabRow(hooks), UNRENAMED, 'tabs (rename skipped)')
  eq(sections(w), ['plugins'], 'sections')
})

await test('read-only label: no rename and no refresh loop', async () => {
  const w = createWorld(); const { hooks } = bootHost(w); bootMarket(w)
  const entry = w.core.entries('settings.plugins.tab').find((e) => e.options.id === 'dsh-market')
  Object.freeze(entry.options)
  const before = w.core.getVersion('settings.plugins.tab')
  const warn = console.warn; let warnings = 0; console.warn = () => { warnings++ }
  try { bootHubPlugin(w); for (let i = 0; i < 5; i++) await flush() } finally { console.warn = warn }
  eq(tabRow(hooks), UNRENAMED, 'tabs')
  eq(sections(w), ['plugins'], 'sections')
  const bumps = w.core.getVersion('settings.plugins.tab') - before
  if (bumps > 1) throw new Error('slot version kept moving: ' + bumps)
  eq(warnings, 1, 'warned once')
})

await test('a market service without render is left alone', async () => {
  const w = createWorld(); const { hooks } = bootHost(w)
  const mctx = w.makeCtx()
  mctx.provide('market', { version: 1, setSettingsVisible: () => { throw new Error('should not be called') } })
  const warn = console.warn; console.warn = () => {}
  try { bootHubPlugin(w); await flush() } finally { console.warn = warn }
  eq(tabRow(hooks), ['插件列表#all'], 'tabs')
})

await test('dictionary namespace does not collide with the host or the market', async () => {
  const { NS } = loadHub()._internal
  if (['settings.plugins', 'dsh-market'].includes(NS)) throw new Error('namespace collision: ' + NS)
})

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed}/${passed + failed}`)
process.exit(failed === 0 ? 0 : 1)
