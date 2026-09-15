/**
 * Regression suite for the assets:// scheme contract in
 * src/electron/electron/{core.cljs,utils.js}.
 *
 * WHY THIS BOOTS A REAL ELECTRON. The bug it guards was not a wrong value that
 * a pure function could have caught: `normalize-asset-resource-url` built a
 * `file://` URL that had always been correct, and stayed correct-looking after
 * the renderer moved from a file:// document to the privileged lsp:// scheme
 * (Electron 43 upgrade, for plugin iframe origins). Chromium then refused every
 * file:// subresource from that origin, and pdf.js reported the blocked read as
 * `Missing PDF "file:///...pdf"` -- indistinguishable from a deleted file. Only
 * a real renderer at a real origin can assert "an asset is fetchable", so that
 * is what this does.
 *
 * It asserts both halves of the contract:
 *   1. an asset inside a registered root IS fetchable from the app's origin;
 *   2. a file outside every registered root is NOT -- including from a plugin
 *      frame, which is the reason containment exists (assets:// is corsEnabled,
 *      so an uncontained handler would hand any plugin every file on disk).
 *
 * The out-of-root file is created on disk on purpose: refusal must come from
 * containment, not from absence. That is the same confusion the original bug
 * turned on.
 *
 * Needs the Electron binary. `yarn install` primes it; from Electron 42 the npm
 * package downloads on first use rather than in a postinstall script, so a
 * sandboxed or offline environment must prime the cache explicitly. The suite
 * SKIPS (it does not fail, and never downloads) when no binary is present.
 * Point it at an unpacked dist with ELECTRON_OVERRIDE_DIST_PATH.
 */
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(here, 'fixtures', 'asset-protocol')
const ASSET_BYTES = Buffer.from('%PDF-1.7\nin-root fixture asset\n')
const SECRET_BYTES = Buffer.from('out-of-root secret\n')
// A relative url() inside the stylesheet: it must resolve against the
// stylesheet's own assets:// URL, which is what a plugin theme relies on.
const STYLESHEET_CSS = Buffer.from(
  'body { --asset-protocol-probe: applied; background-image: url("bg.png"); }\n'
)

/**
 * Locate an Electron binary WITHOUT triggering a download. `require('electron')`
 * downloads when the binary is missing, which a test must never do.
 */
function findElectron () {
  const override = process.env.ELECTRON_OVERRIDE_DIST_PATH
  if (override) {
    const candidate = path.join(override, process.platform === 'win32' ? 'electron.exe' : 'electron')
    if (fs.existsSync(candidate)) return candidate
  }
  const dist = path.join(here, '..', '..', 'node_modules', 'electron', 'dist')
  const pathFile = path.join(here, '..', '..', 'node_modules', 'electron', 'path.txt')
  if (fs.existsSync(pathFile)) {
    const candidate = path.join(dist, fs.readFileSync(pathFile, 'utf-8').trim())
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const electronBinary = findElectron()

describe('assets:// scheme contract', { skip: electronBinary ? false : 'no Electron binary available (see suite header)' }, () => {
  let tmp
  let result

  before(() => {
    tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'asset-protocol-'))
    const root = path.join(tmp, 'graph')
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
    const inRoot = path.join(root, 'assets', 'in-root.pdf')
    fs.writeFileSync(inRoot, ASSET_BYTES)
    // Exists on disk, outside every registered root.
    const outside = path.join(tmp, 'outside-secret.txt')
    fs.writeFileSync(outside, SECRET_BYTES)
    // Same file, reached by traversal from inside the root.
    const traversal = path.join(root, 'assets', '..', '..', 'outside-secret.txt')
    const stylesheet = path.join(root, 'assets', 'theme.css')
    fs.writeFileSync(stylesheet, STYLESHEET_CSS)
    fs.writeFileSync(path.join(root, 'assets', 'bg.png'), Buffer.from('\x89PNG\r\n\x1a\n'))

    const run = spawnSync(electronBinary, ['--no-sandbox', '--disable-gpu', FIXTURE], {
      encoding: 'utf-8',
      timeout: 60000,
      env: {
        ...process.env,
        FIXTURE_ROOT: root,
        FIXTURE_IN_ROOT: inRoot,
        FIXTURE_OUTSIDE: outside,
        FIXTURE_TRAVERSAL: traversal,
        FIXTURE_STYLESHEET: stylesheet,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
      }
    })

    const line = (run.stdout || '').split('\n').find((l) => l.startsWith('ASSET_PROTOCOL_RESULT '))
    assert.ok(
      line,
      'fixture produced no result line.\n--- stdout ---\n' + run.stdout + '\n--- stderr ---\n' + run.stderr
    )
    result = JSON.parse(line.slice('ASSET_PROTOCOL_RESULT '.length))
  })

  after(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('the renderer runs at the privileged lsp:// origin, not file://', () => {
    // If this ever reads file://, the file:// assertion below stops meaning
    // anything and the whole scheme dance is unnecessary -- so assert it.
    assert.equal(result.rendererOrigin, 'lsp://logseq.com')
  })

  test('an asset inside a registered root is fetchable from the app origin', () => {
    const probe = result.mainFrame.assetsInRoot
    assert.equal(probe.status, 200, 'expected 200, got ' + JSON.stringify(probe))
    assert.equal(probe.bytes, ASSET_BYTES.length)
  })

  test('the same asset over file:// is blocked -- this is the bug, and why assets:// is used', () => {
    const probe = result.mainFrame.fileInRoot
    assert.notEqual(probe.status, 200)
    assert.equal(probe.bytes, 0)
    // pdf.js turns exactly this into `Missing PDF "file://..."`, which reads as
    // a deleted file. Keep the asserted shape so the disguise is on record.
    assert.equal(probe.status, 0)
  })

  test('a file outside every registered root is refused, though it exists on disk', () => {
    const probe = result.mainFrame.assetsOutOfRoot
    assert.notEqual(probe.status, 200, 'out-of-root read succeeded: ' + JSON.stringify(probe))
    assert.equal(probe.bytes, 0)
  })

  test('a traversal out of a registered root is refused', () => {
    const probe = result.mainFrame.assetsTraversal
    assert.notEqual(probe.status, 200, 'traversal succeeded: ' + JSON.stringify(probe))
    assert.equal(probe.bytes, 0)
  })

  test('a stylesheet asset loads, applies, and resolves its relative url()', () => {
    // The shape a plugin theme needs. While the theme URL was rewritten to
    // file:// the link errored and the theme silently did nothing.
    const probe = result.mainFrame.stylesheetInRoot
    assert.equal(probe.event, 'load', 'stylesheet did not load: ' + JSON.stringify(probe))
    assert.equal(probe.applied, 'applied')
    assert.match(probe.relativeUrl, /^url\("assets:\/\/.*bg\.png"\)$/)
  })

  test('a plugin frame can read an in-root asset', () => {
    assert.ok(!result.pluginFrame.timedOut, 'plugin frame never reported')
    const probe = result.pluginFrame.assetsInRoot
    assert.equal(probe.status, 200, 'expected 200, got ' + JSON.stringify(probe))
    assert.equal(probe.bytes, ASSET_BYTES.length)
  })

  test('a plugin frame CANNOT read a file outside every registered root', () => {
    assert.ok(!result.pluginFrame.timedOut, 'plugin frame never reported')
    const probe = result.pluginFrame.assetsOutOfRoot
    assert.notEqual(probe.status, 200, 'plugin frame read an out-of-root file: ' + JSON.stringify(probe))
    assert.equal(probe.bytes, 0)
  })
})
