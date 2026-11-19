// dshx-plugin-hub — browser half.
//
// Puts the dshmarket plugin market inside Settings → 内置插件, so plugins live
// in one place:
//
//   设置 → 内置插件 → [ 插件市场 | 插件列表 | 市场设置 ]
//
// 1. Hides the market's own settings section (id "market") through the
//    market's public service: `market.setSettingsVisible(false)`.
// 2. Adds a tab to the host's `settings.plugins.tab` list slot (id
//    "dshx-market-browse", order 5) whose content is `market.render()` —
//    the embedding API dshmarket publishes for exactly this (dshmarket #602).
// 3. Renames dshmarket's own tab in that slot (id "dsh-market", its settings
//    card) from 「插件市场」 to 「市场设置」, so the two tabs are not both
//    called 插件市场.
//
// Why step 3 edits the ledger entry in place: the tab row reads raw
// `ctx.slots.entries()` without de-duplicating, so registering a second
// "dsh-market" entry at a higher priority would show two tabs; and the host
// throws on a second `locale.register` for the same namespace, so the
// market's dictionary cannot be overridden either. The entry's `options` is a
// plain object owned by the slot core, so its `label` thunk is swapped for
// ours, and a version bump makes the tab row re-read it. Step 3 is cosmetic:
// any failure there is logged and leaves steps 1-2 working.
//
// Nothing here runs unless the `market` service exists, so without dshmarket
// the plugin does nothing. Unloading it undoes all three steps.
window.__ModuleLoader__.load({
  id: 'dshx-plugin-hub',
  factory: () => {
    const exports = {}

    const NS = 'dshx-plugin-hub'
    const SLOT = 'settings.plugins.tab'
    const BROWSE_ID = 'dshx-market-browse'
    const BROWSE_ORDER = 5
    const MARKET_TAB_ID = 'dsh-market'
    const REFRESH_ID = 'dshx-plugin-hub-refresh'

    const zh = { browse: '插件市场', marketSettings: '市场设置' }
    const en = { browse: 'Plugin market', marketSettings: 'Market settings' }

    function warn(message, error) {
      try { console.warn('[dshx-plugin-hub] ' + message, error) } catch { /* no console */ }
    }

    /** The market service shape this plugin relies on (dshmarket client, version 1). */
    function usableMarket(market) {
      return market != null &&
        typeof market.render === 'function' &&
        typeof market.setSettingsVisible === 'function'
    }

    /**
     * Mount the hub once the market service exists.
     * @param scoped - context that owns everything below; disposed when the
     *   market service goes away or this plugin unloads.
     * @param t - translator bound to this plugin's namespace.
     */
    function mountHub(scoped, t) {
      const market = scoped.market
      if (!usableMarket(market)) {
        warn('market service lacks render/setSettingsVisible; leaving settings as they are', market)
        return
      }

      // 1. Hide the market's own settings section; give it back on unload.
      scoped.effect(() => {
        try { market.setSettingsVisible(false) } catch (error) { warn('setSettingsVisible(false) failed', error) }
        return () => {
          try { market.setSettingsVisible(true) } catch { /* market already gone */ }
        }
      }, NS + ': hide market section')

      function MarketBrowseTab() {
        return market.render()
      }

      // 3. Relabel dshmarket's settings-card tab.
      const ourLabel = () => t('marketSettings')
      const originals = new Map() // entry -> its original label
      const refused = new WeakSet() // entries whose label would not change

      // Returns true only when a label really changed, so the subscription
      // below cannot loop on an entry that refuses the write (frozen options
      // in some later host would fail silently in sloppy mode).
      function relabel() {
        let changed = false
        try {
          for (const entry of scoped.slots.entries(SLOT)) {
            const options = entry && entry.options
            if (!options || options.id !== MARKET_TAB_ID || options.label === ourLabel || refused.has(entry)) continue
            const original = options.label
            try { options.label = ourLabel } catch { /* checked below */ }
            if (options.label === ourLabel) {
              originals.set(entry, original)
              changed = true
            } else {
              refused.add(entry)
              warn('the dsh-market tab label is read-only; keeping its original name')
            }
          }
        } catch (error) {
          warn('could not rename the dsh-market tab', error)
        }
        return changed
      }

      // Make readers of the slot re-read labels: register and drop a
      // placeholder in the same tick. Both steps bump the slot version
      // synchronously and listeners run in a later microtask, so nobody
      // ever sees the placeholder itself.
      function bumpVersion() {
        try {
          const off = scoped.slots.register({ name: SLOT, id: REFRESH_ID, order: Number.MAX_SAFE_INTEGER, label: '' }, () => null)
          if (typeof off === 'function') off()
        } catch (error) {
          warn('could not refresh the tab row', error)
        }
      }

      scoped.slots.inject(SLOT, () => {
        // Rename first, so the registration below doubles as the refresh.
        relabel()

        // 2. The market itself, first tab of 内置插件.
        scoped.slots.register({
          name: SLOT,
          id: BROWSE_ID,
          order: BROWSE_ORDER,
          label: () => t('browse'),
          locale: NS,
        }, MarketBrowseTab)

        // The dsh-market tab may register after us, or again after a
        // dshmarket reload; rename it whenever it shows up.
        scoped.effect(() => scoped.slots.subscribe(SLOT, () => {
          if (relabel()) bumpVersion()
        }), NS + ': follow dsh-market tab')

        // On unload, give the tab its name back. No refresh needed here: the
        // browse tab's own disposal in the same teardown bumps the version,
        // and listeners only run after the teardown finishes.
        scoped.effect(() => () => {
          try {
            for (const [entry, label] of originals) {
              if (entry.options && entry.options.label === ourLabel) entry.options.label = label
            }
          } catch { /* best effort */ }
          originals.clear()
        }, NS + ': restore dsh-market label')
      })
    }

    exports.name = NS
    exports.inject = ['slots', 'locale']
    exports.apply = (ctx) => {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ': dictionaries')
      const t = ctx.locale.bind(NS)
      // Nested on purpose: a top-level inject of `market` would also work, but
      // nesting keeps the dictionaries registered and makes "no dshmarket"
      // simply mean "the callback never runs".
      ctx.inject(['market'], (scoped) => mountHub(scoped, t))
    }
    exports._internal = { NS, SLOT, BROWSE_ID, BROWSE_ORDER, MARKET_TAB_ID, REFRESH_ID, zh, en, usableMarket }
    return exports
  },
})
