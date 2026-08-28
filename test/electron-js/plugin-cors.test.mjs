/**
 * Regression suite for the lsp:// path containment and the plugin-frame CORS
 * relaxation in src/electron/electron/utils.js.
 *
 * Runs under bare `node --test` -- no Electron, no browser, no build step. The
 * functions under test are pure and take no Electron dependencies, so the whole
 * decision surface is reachable from a plain import.
 *
 * This suite lives outside the deps.edn :paths (src/main src/electron
 * src/resources) so it stays off the shadow-cljs compile surface.
 */
import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  resolveWithin,
  isRegisteredRoot,
  seedPluginRoots,
  clearPluginRoots,
  addPluginRoot,
  pluginRootsFromPreferences,
  resolveExternalPluginAsset,
  resetReseedThrottle,
  isRelaxablePluginRequest,
  rememberPluginRequest,
  clearTrackedRequests,
  trackedRequestCount,
  relaxCorsForPluginFrames,
} from '../../src/electron/electron/utils.js'

describe('resolveWithin', () => {
  const ROOT = path.resolve('/srv/root')

  test('returns the joined path for a contained relative path', () => {
    assert.equal(resolveWithin(ROOT, 'a/b.txt'), path.join(ROOT, 'a/b.txt'))
  })

  test('returns the root itself for an empty relative path', () => {
    assert.equal(resolveWithin(ROOT, ''), ROOT)
  })

  test('refuses a traversal that escapes the root', () => {
    assert.equal(resolveWithin(ROOT, '../../etc/passwd'), null)
  })

  test('refuses a traversal hidden mid-path', () => {
    assert.equal(resolveWithin(ROOT, 'a/../../../etc/passwd'), null)
  })

  test('treats an absolute-looking relative path as relative to the root', () => {
    // path.resolve('/srv/root', '/etc/passwd') would be '/etc/passwd' outright,
    // so the leading separator is stripped before joining.
    assert.equal(resolveWithin(ROOT, '/etc/passwd'), path.join(ROOT, 'etc/passwd'))
  })

  test('refuses a sibling directory whose name merely starts with the root', () => {
    // The startsWith() trap: "/srv/root-evil" is not inside "/srv/root".
    assert.equal(resolveWithin(ROOT, '../root-evil/x'), null)
  })

  test('refuses a missing or non-string root', () => {
    assert.equal(resolveWithin('', 'a'), null)
    assert.equal(resolveWithin(undefined, 'a'), null)
    assert.equal(resolveWithin(null, 'a'), null)
  })

  test('treats a non-string relative path as empty rather than throwing', () => {
    assert.equal(resolveWithin(ROOT, undefined), ROOT)
    assert.equal(resolveWithin(ROOT, null), ROOT)
  })
})

describe('isRegisteredRoot', () => {
  beforeEach(() => clearPluginRoots())

  test('rejects every root before any has been seeded', () => {
    assert.equal(isRegisteredRoot('/home/u/.ssh'), false)
  })

  test('accepts a seeded root and rejects an unseeded one', () => {
    seedPluginRoots(['/home/u/plugins/foo'])
    assert.equal(isRegisteredRoot('/home/u/plugins/foo'), true)
    assert.equal(isRegisteredRoot('/home/u/.ssh'), false)
  })

  test('compares roots after normalisation, not as raw strings', () => {
    seedPluginRoots(['/home/u/plugins/foo'])
    assert.equal(isRegisteredRoot('/home/u/plugins/foo/'), true)
    assert.equal(isRegisteredRoot('/home/u/plugins/bar/../foo'), true)
  })

  test('a seeded PARENT does not make its children roots', () => {
    // Only the recorded root may be served from; resolveWithin then contains the
    // request within it. A child directory is not itself a legitimate root.
    seedPluginRoots(['/home/u/plugins'])
    assert.equal(isRegisteredRoot('/home/u/plugins/foo'), false)
  })

  test('re-seeding replaces the previous set rather than adding to it', () => {
    seedPluginRoots(['/home/u/plugins/foo'])
    seedPluginRoots(['/home/u/plugins/bar'])
    assert.equal(isRegisteredRoot('/home/u/plugins/foo'), false)
    assert.equal(isRegisteredRoot('/home/u/plugins/bar'), true)
  })

  test('ignores junk entries without throwing', () => {
    assert.equal(seedPluginRoots(['/a', '', null, undefined, 42]), 1)
    assert.equal(seedPluginRoots('not-an-array'), 0)
    assert.equal(isRegisteredRoot(''), false)
    assert.equal(isRegisteredRoot(undefined), false)
  })
})

describe('isRelaxablePluginRequest', () => {
  test('relaxes xhr from each of the three plugin frame forms', () => {
    for (const frameUrl of [
      'lsp://logseq.io/my-plugin/index.html',
      'lsp://logseq.com/plugins/my-plugin/index.html',
      'lsp://logseq.com/external/%2Fhome%2Fu%2Fdev/index.html',
    ]) {
      assert.equal(
        isRelaxablePluginRequest({ frameUrl, resourceType: 'xhr' }),
        true,
        frameUrl
      )
    }
  })

  test('does NOT relax the main app frame', () => {
    // The renderer is also served over lsp://, from logseq.com -- matching on the
    // scheme alone would relax the app's own requests.
    assert.equal(
      isRelaxablePluginRequest({
        frameUrl: 'lsp://logseq.com/electron.html',
        resourceType: 'xhr',
      }),
      false
    )
  })

  test('does not relax resource types that never read a cross-origin body', () => {
    const frameUrl = 'lsp://logseq.io/my-plugin/index.html'
    for (const resourceType of ['image', 'script', 'stylesheet', 'font', 'subFrame']) {
      assert.equal(
        isRelaxablePluginRequest({ frameUrl, resourceType }),
        false,
        resourceType
      )
    }
  })

  test('relaxes the "other" type, which is where plain fetch lands', () => {
    assert.equal(
      isRelaxablePluginRequest({
        frameUrl: 'lsp://logseq.io/my-plugin/index.html',
        resourceType: 'other',
      }),
      true
    )
  })

  test('does not relax a non-lsp frame', () => {
    assert.equal(
      isRelaxablePluginRequest({
        frameUrl: 'https://evil.example/index.html',
        resourceType: 'xhr',
      }),
      false
    )
  })

  test('a missing frame url is treated as not-a-plugin, not a crash', () => {
    assert.equal(isRelaxablePluginRequest({ resourceType: 'xhr' }), false)
    assert.equal(isRelaxablePluginRequest({ frameUrl: '', resourceType: 'xhr' }), false)
    assert.equal(isRelaxablePluginRequest(), false)
  })

  test('a plugin-shaped host on the wrong scheme is not a plugin frame', () => {
    assert.equal(
      isRelaxablePluginRequest({
        frameUrl: 'https://logseq.io/my-plugin/index.html',
        resourceType: 'xhr',
      }),
      false
    )
  })
})

describe('pluginRootsFromPreferences', () => {
  const DOT = path.resolve('/home/u/.logseq-og')

  test('always includes the dot-root tmp dir, where generated entries are written', () => {
    // A non-dot-root plugin whose package main is a .js file gets an entry
    // document generated into <dot-root>/tmp by write_user_tmp_file. That
    // directory is never in `externals`, so without it here the entry is refused
    // and the plugin does not load at all.
    assert.ok(pluginRootsFromPreferences(DOT, {}).includes(path.join(DOT, 'tmp')))
  })

  test('includes every external the SDK recorded', () => {
    const roots = pluginRootsFromPreferences(DOT, { externals: ['/a/one', '/b/two'] })
    assert.ok(roots.includes('/a/one'))
    assert.ok(roots.includes('/b/two'))
  })

  test('tolerates a missing, non-array or junk externals list', () => {
    assert.deepEqual(pluginRootsFromPreferences(DOT, null), [path.join(DOT, 'tmp')])
    assert.deepEqual(pluginRootsFromPreferences(DOT, { externals: 'nope' }), [path.join(DOT, 'tmp')])
    assert.deepEqual(
      pluginRootsFromPreferences(DOT, { externals: [null, '', 3, '/ok'] }),
      [path.join(DOT, 'tmp'), '/ok']
    )
  })

  test('yields no roots at all without a dot-root', () => {
    assert.deepEqual(pluginRootsFromPreferences('', {}), [])
  })
})

describe('addPluginRoot', () => {
  beforeEach(() => clearPluginRoots())

  test('allows a root the user picked, which no preferences file mentions yet', () => {
    // The install-time case: PluginLocal#load() fetches the plugin's own scripts
    // before LSPluginCore writes preferences.json, so re-reading that file cannot
    // authorise the plugin being installed. Only the dialog knows.
    const ROOT = path.resolve('/home/u/dev/my-plugin')
    assert.equal(isRegisteredRoot(ROOT), false)
    addPluginRoot(ROOT)
    assert.equal(isRegisteredRoot(ROOT), true)
  })

  test('survives a re-seed from preferences.json', () => {
    // seedPluginRoots replaces the file-derived set. Dropping the session root
    // with it would refuse the plugin mid-install the moment anything re-seeded.
    const ROOT = path.resolve('/home/u/dev/my-plugin')
    addPluginRoot(ROOT)
    seedPluginRoots(['/some/other/root'])
    assert.equal(isRegisteredRoot(ROOT), true)
  })

  test('refuses junk without recording anything', () => {
    assert.equal(addPluginRoot(''), false)
    assert.equal(addPluginRoot(null), false)
    assert.equal(isRegisteredRoot(''), false)
  })

  test('a session root does not make its parent or children roots', () => {
    const ROOT = path.resolve('/home/u/dev/my-plugin')
    addPluginRoot(ROOT)
    assert.equal(isRegisteredRoot(path.resolve('/home/u/dev')), false)
    assert.equal(isRegisteredRoot(path.join(ROOT, 'dist')), false)
  })
})

describe('resolveExternalPluginAsset', () => {
  const ROOT = path.resolve('/srv/plugin')

  beforeEach(() => {
    clearPluginRoots()
    resetReseedThrottle()
  })

  test('serves a contained file from a seeded root without re-reading preferences', () => {
    seedPluginRoots([ROOT])
    let reseeds = 0
    assert.equal(
      resolveExternalPluginAsset(ROOT, '/dist/index.html', () => reseeds++),
      path.join(ROOT, 'dist/index.html')
    )
    assert.equal(reseeds, 0)
  })

  test('re-seeds once for a root installed after startup, then serves it', () => {
    // Roots are seeded at startup; a plugin installed mid-session is in
    // preferences.json but not yet in the seeded set. Refusing it would break the
    // install until the app restarts.
    let reseeds = 0
    const reseed = () => {
      reseeds++
      seedPluginRoots([ROOT])
    }
    assert.equal(
      resolveExternalPluginAsset(ROOT, 'index.html', reseed),
      path.join(ROOT, 'index.html')
    )
    assert.equal(reseeds, 1)
  })

  test('refuses a root that is still unknown after re-seeding', () => {
    assert.equal(resolveExternalPluginAsset('/not/installed', 'index.html', () => {}), null)
  })

  test('still refuses a traversal out of a legitimately seeded root', () => {
    seedPluginRoots([ROOT])
    assert.equal(resolveExternalPluginAsset(ROOT, '../../etc/passwd', () => {}), null)
  })

  test('throttles re-reads, so a stream of bogus roots cannot hammer the disk', () => {
    let reseeds = 0
    const reseed = () => reseeds++
    for (let i = 0; i < 50; i++) resolveExternalPluginAsset(`/bogus/${i}`, 'x', reseed)
    assert.equal(reseeds, 1)
  })

  test('a throwing re-seed refuses rather than propagating', () => {
    assert.equal(
      resolveExternalPluginAsset(ROOT, 'index.html', () => {
        throw new Error('preferences.json is unreadable')
      }),
      null
    )
  })
})

describe('relaxCorsForPluginFrames', () => {
  const headersOf = (h) => {
    const d = { id: 1, responseHeaders: h }
    relaxCorsForPluginFrames(d)
    return d.responseHeaders
  }

  beforeEach(() => clearTrackedRequests())

  test('leaves an unattributed response completely alone', () => {
    const h = { 'Content-Type': ['text/plain'] }
    assert.deepEqual(headersOf(h), { 'Content-Type': ['text/plain'] })
  })

  test('publishes a wildcard origin for an attributed request', () => {
    rememberPluginRequest(1)
    const h = headersOf({})
    // A WILDCARD, never the echoed origin: the browser rejects "*" for
    // credentialed requests, which is what keeps cookie-bearing cross-origin
    // reads blocked.
    assert.deepEqual(h['Access-Control-Allow-Origin'], ['*'])
    assert.deepEqual(h['Access-Control-Allow-Headers'], ['*'])
    assert.ok(h['Access-Control-Allow-Methods'])
  })

  test('exposes response headers, so a plugin can read more than the CORS-safelisted ones', () => {
    rememberPluginRequest(1)
    assert.deepEqual(headersOf({})['Access-Control-Expose-Headers'], ['*'])
  })

  test('replaces an existing header whatever its casing, rather than duplicating it', () => {
    rememberPluginRequest(1)
    const h = headersOf({ 'access-control-allow-origin': ['https://example.com'] })
    assert.equal(h['access-control-allow-origin'], undefined)
    assert.deepEqual(h['Access-Control-Allow-Origin'], ['*'])
  })

  test('keeps relaxing across the hops of a redirect chain', () => {
    // onHeadersReceived fires once per hop. Dropping the entry on the first
    // response would leave the final one unrelaxed.
    rememberPluginRequest(1)
    headersOf({})
    assert.deepEqual(headersOf({})['Access-Control-Allow-Origin'], ['*'])
  })

  test('does not touch headers it was not asked about', () => {
    rememberPluginRequest(1)
    assert.deepEqual(headersOf({ 'Content-Type': ['application/json'] })['Content-Type'], [
      'application/json',
    ])
  })
})

describe('plugin request tracking', () => {
  beforeEach(() => clearTrackedRequests())

  test('stays bounded under a flood of requests that are all still young', () => {
    for (let i = 0; i < 3000; i++) rememberPluginRequest(i)
    assert.ok(trackedRequestCount() <= 2000, `tracked ${trackedRequestCount()}`)
  })

  test('a flood evicts the oldest entries and keeps the newest', () => {
    for (let i = 0; i < 3000; i++) rememberPluginRequest(i)
    assert.ok(trackedRequestCount() > 0)
    const d = { id: 2999, responseHeaders: {} }
    relaxCorsForPluginFrames(d)
    assert.deepEqual(d.responseHeaders['Access-Control-Allow-Origin'], ['*'])
  })
})

describe('compiled release output (guard)', () => {
  const loadBuilt = async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const built = fileURLToPath(new URL('../../static/electron.js', import.meta.url))
    return existsSync(built) ? readFileSync(built, 'utf8') : null
  }

  // Closure renames symbols in a release build, so this guard can only READ the
  // compiled output when it was built with pseudo-names (`--debug`, which is what
  // cljs:release-electron passes). A plain release renames resolveWithin away
  // entirely and there is nothing left to match on.
  //
  // The distinction matters: an earlier version of this guard looked for a marker
  // that never appears in ANY build and returned early when it was missing, so it
  // passed unconditionally and protected nothing. If the build is observable, a
  // missing marker is now a FAILURE, not a silent skip.
  const isPseudoNamed = (s) => /\.\$[a-zA-Z_]+\$/.test(s)
  // The DEFINITION, not the `module.resolveWithin =` export line: once a second
  // caller exists inside the module Closure emits the export as a bare alias and
  // the body lands elsewhere in the file. Anchoring on the export site silently
  // inspected the wrong function.
  const MARKER = '$resolveWithin$$module$electron$utils$$ = ('

  // src/electron/electron/utils.js is Closure-compiled under :advanced in a
  // RELEASE build, which renames any path.* PROPERTY it has no extern for.
  // path.sep and path.relative both compiled to mangled keys that are undefined on
  // Node's real path object, so resolveWithin's containment check became
  // startsWith(base + "undefined") -- false for every contained path. It then
  // refused the app's own electron.html and the window came up blank, in release
  // builds only. A dev `cljs compile` does NOT rename properties and cannot catch
  // this. Rule: do containment with plain string ops, never path.sep/path.relative.
  test('resolveWithin has no mangled path.* property', async () => {
    const s = await loadBuilt()
    if (!s) return // not built; run `clojure -M:cljs release electron --debug`
    if (!isPseudoNamed(s)) return // plain release build: symbols are unrecoverable

    const i = s.indexOf(MARKER)
    assert.notEqual(
      i,
      -1,
      `guard could not find ${MARKER} in a pseudo-named build -- the marker is ` +
        'stale and this check is protecting nothing; fix the marker (Closure ' +
        'moves the definition when the set of callers changes)'
    )
    const body = s.slice(i, i + 1200)
    assert.ok(
      !/\.\$(sep|relative|normalize)\$/.test(body),
      'compiled resolveWithin references a mangled path.* property -- undefined at runtime'
    )
    // The externs-covered calls must survive UNmangled, or containment is broken
    // in the other direction.
    assert.ok(
      /\.resolve\(/.test(body) && /\.join\(/.test(body),
      'compiled resolveWithin lost path.resolve/path.join -- check externs.js'
    )
  })

  test('the preferences.json read stays quoted, not renamed to a mangled key', async () => {
    // preferences.json is parsed data, so no extern can cover a dotted read of it.
    // `prefs.externals` compiled to a mangled property that is undefined on the
    // real object: only the tmp root was seeded and every external plugin was
    // refused. Note a pseudo-named build spells the mangled form `.$externals$`,
    // which still CONTAINS the word -- so grepping for "externals" is not a check.
    const s = await loadBuilt()
    if (!s) return
    if (!isPseudoNamed(s)) return

    const i = s.indexOf('$pluginRootsFromPreferences$')
    assert.notEqual(i, -1, 'guard could not find pluginRootsFromPreferences; fix the marker')
    const body = s.slice(i, i + 900)
    assert.ok(
      !/\.\$externals\$/.test(body),
      'the externals read was renamed -- quote it as prefs[\'externals\']'
    )
    // Closure emits a quoted read back as plain `.externals` but marks it
    // un-renameable, so the surviving evidence is the UNmangled name, not a
    // quoted literal.
    assert.ok(/\.externals\b/.test(body), 'the externals read has gone missing entirely')
  })

  test('the webRequest names used by the CORS policy survive renaming', async () => {
    const s = await loadBuilt()
    if (!s) return
    if (!isPseudoNamed(s)) return
    for (const name of ['onBeforeRequest', 'onHeadersReceived', 'responseHeaders', 'resourceType']) {
      assert.ok(
        !new RegExp(`\\.\\$${name}\\$`).test(s),
        `${name} was renamed -- it needs an entry in externs.js, or the call fails ` +
          'at runtime and aborts app setup before the main IPC channel registers'
      )
    }
  })
})
