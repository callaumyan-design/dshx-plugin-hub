// UI smoke test against a running DSH: opens Settings → 内置插件 and reports
// the settings nav rows and the plugin tabs. Mints the browser-session cookie
// like dsh/tools/verify-plugin-compat.mjs and never prints it.
//
//   node ui-smoke.mjs http://127.0.0.1:<port> [screenshotDir]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const PW = 'file:///F:/ds/outputs/2026-10-26-dsh-project-spaces/tests/browser-tooling/node_modules/playwright-core/index.mjs'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const GUI = process.argv[2]
const OUT = process.argv[3] || os.tmpdir()
if (!GUI) { console.error('usage: node ui-smoke.mjs http://127.0.0.1:<port> [dir]'); process.exit(2) }

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const yaml = createRequire(path.join(HOME, 'profiles', 'desktop', 'package.json'))('js-yaml')
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
function mintCookie() {
  const doc = yaml.load(fs.readFileSync(path.join(HOME, '.credentials.yaml'), 'utf8'))
  const s = doc.records['client-connection/browser-session'].payload.secret
  const secret = Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - s.length % 4) % 4), 'base64')
  const authority = new URL(GUI).host
  const now = Date.now()
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 600 * 1000 }), 'utf8'))
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest())
  return { name: `dsh-auth-${b64url(crypto.createHash('sha256').update(authority).digest())}`, value: `v1.${body}.${sig}` }
}

const { chromium } = await import(PW)
const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const report = { errors: [], warnings: [] }
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
  const c = mintCookie()
  await context.addCookies([{ name: c.name, value: c.value, url: GUI }])
  const page = await context.newPage()
  page.on('pageerror', (e) => report.errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('dshx-plugin-hub')) report.warnings.push(m.text()) })
  await page.goto(GUI, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)

  // Open Settings: try the shortcut, then any visible 设置 control.
  const dialog = page.locator('[role="dialog"]').filter({ has: page.locator('nav') })
  await page.keyboard.press('Control+Comma')
  await page.waitForTimeout(1200)
  if (!(await dialog.count())) {
    // 0.2.1: the sidebar footer 「··· 更多」 opens the account menu that holds 设置.
    for (const sel of ['[aria-label="设置"]', 'button:has-text("设置")', 'button:has-text("更多") >> nth=-1', '[aria-label*="账户"]', '[aria-label*="Account"]']) {
      const el = page.locator(sel).first()
      if (await el.count()) { await el.click().catch(() => {}); await page.waitForTimeout(800) }
      if (await dialog.count()) break
      const item = page.locator('[role="menuitem"]:has-text("设置")').first()
      if (await item.count()) { await item.click().catch(() => {}); await page.waitForTimeout(800) }
      if (await dialog.count()) break
    }
  }
  report.dialogOpen = (await dialog.count()) > 0
  if (report.dialogOpen) {
    report.nav = (await dialog.locator('nav button').allInnerTexts()).map((s) => s.trim()).filter(Boolean)
    const pluginsRow = dialog.locator('nav button', { hasText: '内置插件' }).first()
    if (await pluginsRow.count()) {
      await pluginsRow.click()
      await page.waitForTimeout(2500)
      const tabs = dialog.locator('[role="tablist"] [role="tab"]')
      report.tabs = (await tabs.allInnerTexts()).map((s) => s.trim())
      report.activeTab = (await dialog.locator('[role="tab"][aria-selected="true"]').allInnerTexts()).map((s) => s.trim())
      const panel = dialog.locator('[role="tabpanel"]:not([hidden])').first()
      report.panelText = ((await panel.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 200)
      report.panelWidth = await panel.evaluate((el) => el.getBoundingClientRect().width).catch(() => null)
      await page.screenshot({ path: path.join(OUT, 'hub-market-tab.png') })
      const settingsTab = dialog.locator('[role="tab"]', { hasText: '市场设置' }).first()
      if (await settingsTab.count()) {
        await settingsTab.click(); await page.waitForTimeout(1200)
        report.settingsTabText = ((await dialog.locator('[role="tabpanel"]:not([hidden])').first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 160)
        await page.screenshot({ path: path.join(OUT, 'hub-settings-tab.png') })
      }
    }
  } else {
    await page.screenshot({ path: path.join(OUT, 'hub-no-dialog.png') })
  }
} finally {
  await browser.close()
}
console.log(JSON.stringify(report, null, 1))
