/**
 * Unit suite for the assets:// root containment and URL resolution in
 * src/electron/electron/utils.js.
 *
 * Bare `node --test` -- no Electron, no build step: resolveAssetsSchemeUrl and
 * the root registry are pure. The companion suite asset-protocol.test.mjs boots
 * a real Electron for the part no pure function can assert, namely that an
 * asset is actually FETCHABLE from the renderer's origin.
 *
 * It lives outside the deps.edn :paths so it stays off the shadow-cljs compile
 * surface, like plugin-cors.test.mjs.
 */
import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  ASSETS_SCHEME_PRIVILEGES,
  LSP_SCHEME_PRIVILEGES,
  seedAssetRoots,
  clearAssetRoots,
  assetRootCount,
  resolveAssetsSchemeUrl
} from '../../src/electron/electron/utils.js'

const GRAPH = path.resolve('/srv/graph')
const ALIAS = path.resolve('/srv/media')

describe('scheme privileges', () => {
  test('assets:// is fetch-capable and CORS-enabled', () => {
    // Without both, the renderer (origin lsp://logseq.com) cannot read an
    // asset at all: this is the bug the assets:// switch fixed.
    assert.equal(ASSETS_SCHEME_PRIVILEGES.supportFetchAPI, true)
    assert.equal(ASSETS_SCHEME_PRIVILEGES.corsEnabled, true)
  })

  test('assets:// is NOT a standard scheme', () => {
    // Load-bearing: under a standard scheme Chromium reparses the URL and the
    // leading slash of an absolute path becomes the hostname, so
    // assets:///home/x arrives as host "home" + path "/x". Every assets:// URL
    // the renderer builds is an absolute path.
    assert.equal(ASSETS_SCHEME_PRIVILEGES.standard, false)
  })

  test('the renderer scheme is standard and secure', () => {
    assert.equal(LSP_SCHEME_PRIVILEGES.standard, true)
    assert.equal(LSP_SCHEME_PRIVILEGES.secure, true)
  })

  test('privilege keys are quoted, so Closure :advanced cannot rename them', () => {
    // A renamed key registers a scheme with DEFAULT privileges and fails only
    // in a release build. Assert the real names are present as written.
    for (const key of ['standard', 'secure', 'bypassCSP', 'supportFetchAPI', 'corsEnabled']) {
      assert.ok(key in ASSETS_SCHEME_PRIVILEGES, 'missing privilege key: ' + key)
    }
  })
})

describe('seedAssetRoots', () => {
  beforeEach(() => clearAssetRoots())

  test('registers each non-empty string root', () => {
    assert.equal(seedAssetRoots([GRAPH, ALIAS]), 2)
    assert.equal(assetRootCount(), 2)
  })

  test('replaces rather than accumulates, so a closed graph stops being a root', () => {
    seedAssetRoots([GRAPH, ALIAS])
    assert.equal(seedAssetRoots([GRAPH]), 1)
    assert.equal(resolveAssetsSchemeUrl('assets://' + path.join(ALIAS, 'a.png')), null)
  })

  test('ignores non-strings, empty strings and a non-array argument', () => {
    assert.equal(seedAssetRoots([GRAPH, '', null, 42, undefined]), 1)
    assert.equal(seedAssetRoots('not an array'), 0)
    assert.equal(assetRootCount(), 0)
  })

  test('with no roots seeded, nothing resolves', () => {
    assert.equal(resolveAssetsSchemeUrl('assets://' + path.join(GRAPH, 'assets', 'a.pdf')), null)
  })
})

describe('resolveAssetsSchemeUrl', () => {
  beforeEach(() => {
    clearAssetRoots()
    seedAssetRoots([GRAPH, ALIAS])
  })

  test('resolves a path inside a registered root', () => {
    const file = path.join(GRAPH, 'assets', 'a.pdf')
    assert.equal(resolveAssetsSchemeUrl('assets://' + file), file)
  })

  test('resolves a path inside any of several roots', () => {
    const file = path.join(ALIAS, 'music', 'b.mp3')
    assert.equal(resolveAssetsSchemeUrl('assets://' + file), file)
  })

  test('resolves the root itself', () => {
    assert.equal(resolveAssetsSchemeUrl('assets://' + GRAPH), GRAPH)
  })

  test('refuses a path outside every root', () => {
    assert.equal(resolveAssetsSchemeUrl('assets:///etc/passwd'), null)
  })

  test('refuses a sibling directory whose name merely starts with a root', () => {
    // The containment check is a string compare, so "/srv/graph-evil" must not
    // pass as "inside /srv/graph".
    assert.equal(resolveAssetsSchemeUrl('assets://' + path.resolve('/srv/graph-evil/x.pdf')), null)
  })

  test('refuses a traversal out of a root', () => {
    assert.equal(
      resolveAssetsSchemeUrl('assets://' + path.join(GRAPH, 'assets', '..', '..', 'secret.txt')),
      null
    )
  })

  test('refuses an encoded traversal out of a root', () => {
    assert.equal(resolveAssetsSchemeUrl('assets://' + GRAPH + '/assets/%2e%2e/%2e%2e/secret.txt'), null)
  })

  test('decodes percent-encoding in a contained path', () => {
    const file = path.join(GRAPH, 'assets', 'my file.pdf')
    assert.equal(resolveAssetsSchemeUrl('assets://' + GRAPH + '/assets/my%20file.pdf'), file)
  })

  test('decodes a literal percent in a filename', () => {
    const file = path.join(GRAPH, 'assets', '100% done.pdf')
    assert.equal(resolveAssetsSchemeUrl('assets://' + GRAPH + '/assets/100%25%20done.pdf'), file)
  })

  test('refuses a malformed escape rather than serving the raw bytes', () => {
    assert.equal(resolveAssetsSchemeUrl('assets://' + GRAPH + '/assets/%zz.pdf'), null)
  })

  test('refuses a url of another scheme, and a non-string', () => {
    assert.equal(resolveAssetsSchemeUrl('file://' + path.join(GRAPH, 'assets', 'a.pdf')), null)
    assert.equal(resolveAssetsSchemeUrl('lsp://logseq.com/index.html'), null)
    assert.equal(resolveAssetsSchemeUrl(null), null)
    assert.equal(resolveAssetsSchemeUrl(undefined), null)
  })

  test('resolves a Windows drive path, which arrives as /C:/...', () => {
    clearAssetRoots()
    seedAssetRoots(['/C:/Users/nils/graph'])
    assert.equal(
      resolveAssetsSchemeUrl('assets:///C:/Users/nils/graph/assets/a.pdf', { win32: false }),
      path.resolve('/C:/Users/nils/graph/assets/a.pdf')
    )
  })

  test('refuses a relative path on a non-Windows host', () => {
    // Nothing legitimate produces one: every assets:// URL the renderer builds
    // is absolute.
    assert.equal(resolveAssetsSchemeUrl('assets://srv/graph/assets/a.pdf', { win32: false }), null)
  })
})

describe('compiled release output (guard)', () => {
  const loadBuilt = async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const built = fileURLToPath(new URL('../../static/electron.js', import.meta.url))
    return existsSync(built) ? readFileSync(built, 'utf8') : null
  }

  // Same reading rules as the guard in plugin-cors.test.mjs: the compiled output
  // is only inspectable when it was built with pseudo-names (`--debug`, which
  // cljs:release-electron passes); a plain release renames the anchors away.
  const isPseudoNamed = (s) => /\.\$[a-zA-Z_]+\$/.test(s)

  // The privilege tables are plain JS object literals in utils.js, which IS
  // Closure-compiled under :advanced in a release build. Electron reads these
  // keys by their real names, so a renamed key does not error -- it registers
  // the scheme with DEFAULT privileges. assets:// would lose supportFetchAPI +
  // corsEnabled and every asset read would start failing again, in release
  // builds only, which is why the keys are quoted at the definition. `standard`
  // is asserted for the same reason in reverse: renamed away, it would default
  // to false and keep working by luck, so it has to be verifiably present.
  test('the assets:// privilege keys survive :advanced renaming', async () => {
    const s = await loadBuilt()
    if (!s) return // not built; run `clojure -M:cljs release electron --debug`
    if (!isPseudoNamed(s)) return // plain release build: anchors are unrecoverable

    // corsEnabled exists nowhere else in the bundle, so its presence as an
    // object key is proof the literal was not renamed.
    assert.match(
      s,
      /corsEnabled\s*:/,
      'compiled output has no `corsEnabled:` key -- Closure renamed the assets:// ' +
        'privilege table, so a release build registers the scheme with default ' +
        'privileges and every asset fetch fails (quote the keys in utils.js)'
    )
    const i = s.search(/corsEnabled\s*:/)
    const around = s.slice(Math.max(0, i - 200), i + 200)
    for (const key of ['standard', 'secure', 'bypassCSP', 'supportFetchAPI']) {
      assert.ok(
        around.includes(key + ':'),
        `compiled assets:// privilege table is missing \`${key}:\` -- renamed by :advanced`
      )
    }
  })
})
