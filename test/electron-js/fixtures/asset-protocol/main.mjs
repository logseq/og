/**
 * Fixture app for test/electron-js/asset-protocol.test.mjs.
 *
 * It boots a real Electron with the SAME scheme privileges and the SAME
 * assets:// URL resolver the app registers, imported from
 * src/electron/electron/utils.js -- not a copy. A copy would drift, and the
 * contract under test (an asset must be fetchable from the app's own origin,
 * and only from inside a registered root) lives exactly in those two values.
 *
 * What is fixture-local and therefore NOT a guarantee about the app: the
 * BrowserWindow options below. webSecurity is set true to match a packaged
 * build (the app uses `(not dev?)`), and no preload is installed, so this
 * fixture cannot make claims about the app's preload scoping.
 */
import { app, protocol, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LSP_SCHEME_PRIVILEGES,
  ASSETS_SCHEME_PRIVILEGES,
  seedAssetRoots,
  resolveAssetsSchemeUrl
} from '../../../../src/electron/electron/utils.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const FIXTURE_ROOT = process.env.FIXTURE_ROOT
const IN_ROOT = process.env.FIXTURE_IN_ROOT
const OUTSIDE = process.env.FIXTURE_OUTSIDE
const TRAVERSAL = process.env.FIXTURE_TRAVERSAL
const STYLESHEET = process.env.FIXTURE_STYLESHEET

const fail = (why) => {
  console.log('ASSET_PROTOCOL_FATAL ' + why)
  app.exit(2)
}

if (!FIXTURE_ROOT || !IN_ROOT || !OUTSIDE || !TRAVERSAL || !STYLESHEET) {
  fail('fixture env not set')
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'lsp', privileges: LSP_SCHEME_PRIVILEGES },
  { scheme: 'assets', privileges: ASSETS_SCHEME_PRIVILEGES }
])

app.whenReady().then(() => {
  seedAssetRoots([FIXTURE_ROOT])

  // Serves the fixture's own documents. /plugins/<x> maps to <x> so the probe
  // can run from a URL the app treats as a plugin frame.
  protocol.registerFileProtocol('lsp', (request, callback) => {
    const pathname = new URL(request.url).pathname.replace(/^\/plugins\//, '/')
    callback({ path: path.join(here, pathname) })
  })

  // The app's handler, reduced to its decision: resolve, or refuse with
  // net::ERR_FILE_NOT_FOUND.
  protocol.registerFileProtocol('assets', (request, callback) => {
    const resolved = resolveAssetsSchemeUrl(request.url)
    if (resolved) callback({ path: resolved })
    else callback({ error: -6 })
  })

  const win = new BrowserWindow({
    show: false,
    webPreferences: { webSecurity: true, contextIsolation: true, sandbox: false, nodeIntegration: false }
  })

  win.webContents.on('console-message', (...args) => {
    // Electron 43 passes an event object; older signatures passed (event, level, message).
    const message = typeof args[0] === 'object' && args[0] !== null && 'message' in args[0]
      ? args[0].message
      : args[2]
    if (typeof message !== 'string') return
    if (message.startsWith('ASSET_PROTOCOL_RESULT ')) {
      console.log(message)
      app.exit(0)
    } else {
      console.log('[renderer] ' + message)
    }
  })

  // Query params rather than an injected global: the probe scripts read them
  // synchronously at parse time, with no ordering race against the page load.
  const query = new URLSearchParams({ in: IN_ROOT, out: OUTSIDE, trav: TRAVERSAL, css: STYLESHEET })
  win.loadURL('lsp://logseq.com/index.html?' + query)
  setTimeout(() => fail('timed out waiting for probe result'), 25000)
})
