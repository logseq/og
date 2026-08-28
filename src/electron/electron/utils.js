import path from 'path'
import fse from 'fs-extra'

// workaround from https://github.com/electron/electron/issues/426#issuecomment-658901422
// We set an intercept on incoming requests to disable x-frame-options
// headers.

// Should we do this? Does this make evil sites doing danagerous things?

// ---------------------------------------------------------------------------
// Plugin frames, the lsp:// scheme, and CORS
//
// Plugin frames are served over the privileged lsp:// scheme, which is a real
// origin, so Chromium enforces CORS on the requests they make. Most endpoints a
// plugin talks to either send no Access-Control-Allow-Origin at all (ordinary web
// pages, local APIs such as Zotero or Syncthing) or omit the plugin's custom client
// header from Access-Control-Allow-Headers, so the request fails before it is sent.
// The previous file:// renderer had no CORS applied and the same calls worked.
//
// Why this is not a new capability: any plugin can already perform unrestricted
// HTTP through logseq.Request -> exper_request -> node-fetch in the main process,
// with arbitrary URLs and headers and no CORS at all. Against a hostile plugin,
// browser CORS is not a boundary here; it only penalises honest plugins using
// plain fetch.
//
// The one thing browser CORS still buys us is protection of *ambient* credentials:
// a main-process request carries no browser cookies, a credentialed fetch does. So
// we publish a WILDCARD origin rather than echoing the request origin -- the browser
// rejects "*" outright for credentialed requests, which keeps cookie-bearing
// cross-origin reads blocked while ordinary plugin requests succeed. Do not change
// this to echo the origin: combined with a server sending
// Access-Control-Allow-Credentials, that would let a plugin read another site's
// authenticated responses, which IS an escalation over what it can do today.
//
// Unlike webSecurity:false this leaves the same-origin policy for DOM access and
// mixed-content blocking untouched.
//
// IMPORTANT, and easy to get wrong when testing this: the SDK installs a fetch
// bridge in every plugin frame that routes http(s) `fetch` to the main process. A
// bridged request never reaches Chromium's CORS layer at all, so the headers below
// apply only to UNBRIDGED requests from plugin frames -- XHR, and anything issued
// before the bridge installs.
//
// NOTE: this must stay inside the single onHeadersReceived listener below --
// Electron allows only ONE listener per method per session, so a second
// registration elsewhere silently replaces this one.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// External plugin roots
//
// Plugins installed outside the dot-root are served from
// lsp://logseq.com/external/<urlencoded-root>/..., i.e. the URL names the
// directory to serve from. resolveWithin can only verify that the file stays
// inside the root it was given; it cannot know whether that root is legitimate.
// Without an allowlist, a URL naming any directory on disk would be served
// through the privileged lsp:// scheme.
//
// Roots are seeded once at startup from the SDK's own record of installed
// external plugins (preferences.json "externals"), which is the right source of
// truth for "which roots may be served from".
// ---------------------------------------------------------------------------
const seededRoots = new Set()

// Roots the user chose in THIS session, which no re-seed may drop.
//
// Load order forces the split. PluginLocal#load() mounts the plugin's frame --
// which fetches its entry document and then its own scripts over lsp:// --
// BEFORE LSPluginCore registers the plugin and writes preferences.json. So on a
// first install the file is not yet a record of anything, and re-reading it
// cannot authorise the very plugin being installed. The authority for that one
// is the directory the user picked in the load-unpacked-plugin dialog, which the
// main process learns first-hand.
const sessionRoots = new Set()

export const seedPluginRoots = (roots) => {
  seededRoots.clear()
  if (!Array.isArray(roots)) return 0
  for (const r of roots) {
    if (typeof r === 'string' && r !== '') seededRoots.add(path.resolve(r))
  }
  return seededRoots.size + sessionRoots.size
}

/**
 * Allow one root for the rest of the session. Called only from the
 * load-unpacked-plugin dialog handler, where the path is the user's own choice --
 * never from anything a plugin or the renderer can drive with a path of its own.
 */
export const addPluginRoot = (root) => {
  if (typeof root !== 'string' || root === '') return false
  sessionRoots.add(path.resolve(root))
  return true
}

/** Test seam. Not used by the app. */
export const clearPluginRoots = () => {
  seededRoots.clear()
  sessionRoots.clear()
}

/**
 * Is this fs path the root of an external plugin the user actually installed?
 * Anything else is a URL naming a path of its own choosing.
 */
export const isRegisteredRoot = (candidate) => {
  if (typeof candidate !== 'string' || candidate === '') return false
  const resolved = path.resolve(candidate)
  return seededRoots.has(resolved) || sessionRoots.has(resolved)
}

/**
 * The roots that may legitimately be served over lsp://logseq.com/external/.
 *
 * Two sources, and both are needed:
 *  - preferences.json "externals", the SDK's record of the external plugins the
 *    user installed; and
 *  - <dot-root>/tmp, where the SDK generates an entry document for a plugin whose
 *    package `main` is a .js file (write_user_tmp_file). For a plugin outside the
 *    dot-root that document is addressed with ITS OWN directory as the root, and
 *    that directory is never an "external", so leaving it out refuses the entry
 *    and the plugin never loads.
 *
 * The tmp dir is app-controlled rather than named by the URL, so trusting it adds
 * no reach a plugin did not already have.
 */
export const pluginRootsFromPreferences = (dotRoot, prefs) => {
  const roots = []
  if (typeof dotRoot !== 'string' || dotRoot === '') return roots
  roots.push(path.join(dotRoot, 'tmp'))
  // QUOTED, and it must stay quoted. This module is Closure-compiled under
  // :advanced, which renames any property read it has no extern for -- and
  // preferences.json is parsed data, so there is nothing to write an extern
  // against. `prefs.externals` compiled to a mangled key that is undefined on the
  // real object, silently seeding the tmp root alone and refusing every plugin
  // installed outside the dot-root. A quoted read is a string literal and cannot
  // be renamed.
  const externals = prefs && prefs['externals']
  if (Array.isArray(externals)) {
    for (const e of externals) {
      if (typeof e === 'string' && e !== '') roots.push(e)
    }
  }
  return roots
}

/**
 * Resolve a file on the lsp://.../external/<root>/<relative> route.
 *
 * Roots are seeded at startup, but a plugin installed from outside the dot-root
 * DURING a session is written to preferences.json only after startup, so its
 * assets would be refused until the app restarted. On a miss, re-read once
 * through `reseed` and decide again; a root that is still unknown afterwards is
 * a URL naming a directory of its own choosing, and is refused.
 *
 * Returns the absolute path to serve, or null.
 */
const RESEED_THROTTLE_MS = 1000
let lastReseedAt = 0

/** Test seam. Not used by the app. */
export const resetReseedThrottle = () => {
  lastReseedAt = 0
}

export const resolveExternalPluginAsset = (root, relative, reseed) => {
  if (!isRegisteredRoot(root)) {
    if (typeof reseed !== 'function') return null
    // A URL is free to name any root it likes, and every unknown one would
    // otherwise cost a preferences.json read. Throttle: a genuine mid-session
    // install is one event, not a stream.
    const now = Date.now()
    if (now - lastReseedAt < RESEED_THROTTLE_MS) return null
    lastReseedAt = now
    try {
      reseed()
    } catch (e) {
      // An unreadable preferences.json is not a reason to serve an unverified
      // root. Fail closed.
      console.error('[lsp] could not refresh external plugin roots:', e)
      return null
    }
    if (!isRegisteredRoot(root)) return null
  }
  return resolveWithin(root, relative)
}

/**
 * Join `relative` onto `root` and return the result ONLY if it stays inside
 * `root`; otherwise null. The containment check is the point -- `path.join`
 * happily walks out of the root given "../..", and a naive startsWith() would
 * accept "/srv/root-evil" as being inside "/srv/root".
 */
export const resolveWithin = (root, relative) => {
  if (typeof root !== 'string' || root === '') return null
  const base = path.resolve(root)
  const rel = typeof relative === 'string' ? relative : ''
  // Strip a leading separator so an absolute-looking relative path cannot
  // replace the base outright (path.resolve('/a', '/etc/passwd') === '/etc/passwd').
  const full = path.resolve(path.join(base, rel.replace(/^[/\\]+/, '')))
  // Containment check with PURE STRING ops -- deliberately no path.sep and no
  // path.relative. Both are covered by externs only partially, so Closure
  // :advanced (release builds ONLY) renamed them to mangled keys that are
  // undefined on Node's real path object; the check then silently failed for
  // every contained path and refused even the app's own electron.html. `base` is
  // already path.resolve'd, so it has no trailing separator; a contained path is
  // base itself or base followed by a separator. Check both separators so this
  // needs neither path.sep nor a platform assumption. String literals and
  // String.prototype.startsWith cannot be mangled.
  if (full === base || full.startsWith(base + '/') || full.startsWith(base + '\\')) {
    return full
  }
  return null
}

// Only these are plugin frames. Note the main renderer is ALSO lsp://logseq.com
// (electron.html), so matching on the scheme alone would relax the app's own
// requests too -- match on the plugin paths specifically.
//   lsp://logseq.io/...              whole host is the plugins root (legacy + namespaced)
//   lsp://logseq.com/plugins/...     dot-root installs
//   lsp://logseq.com/external/...    plugins installed outside the dot-root
const PLUGIN_FRAME_RE =
  /^lsp:\/\/(logseq\.io\/|logseq\.com\/(plugins|external)\/)/

// CORS relaxation is only needed for fetch/XHR. Images, stylesheets, fonts,
// media, scripts and subframes do not read response bodies cross-origin, so they
// never needed the relaxed ACAO headers.
const RELAXABLE_RESOURCE_TYPES = new Set(['xhr', 'other'])

/**
 * Should this request's response be CORS-relaxed? True only for a request whose
 * initiating frame is a plugin frame AND whose resource type actually reads a
 * cross-origin body. Pure and synchronous so it is unit-testable.
 */
export const isRelaxablePluginRequest = ({ frameUrl, resourceType } = {}) => {
  if (typeof frameUrl !== 'string' || !PLUGIN_FRAME_RE.test(frameUrl)) return false
  return RELAXABLE_RESOURCE_TYPES.has(resourceType)
}

// details.frame is documented as nullable once a frame has navigated or been
// destroyed, so it cannot be trusted at onHeadersReceived time. onBeforeRequest
// fires while the frame is still alive, so identity is resolved THERE and recorded
// against the webRequest id, which is stable for the life of the request.
//
// Anything not positively identified as a plugin request is left untouched: this
// must fail CLOSED. A request we cannot attribute is not a request we relax.
const pluginRequestIds = new Map() // id -> timestamp
const MAX_TRACKED_REQUESTS = 2000
// Long enough to outlive any realistic request/response round trip, so a slow
// download does not lose its entry before onHeadersReceived fires -- which would
// silently drop the CORS relaxation and fail a request that should have worked.
const TRACKED_REQUEST_TTL_MS = 10 * 60 * 1000

/**
 * Evict by AGE, not by insertion order. A count-based "drop the oldest quarter"
 * evicts whatever is oldest even when it is still in flight: a long-lived request
 * that outlived 500 later ones lost its relaxation mid-flight.
 */
const evictStaleRequests = () => {
  const cutoff = Date.now() - TRACKED_REQUEST_TTL_MS
  for (const [k, t] of pluginRequestIds) {
    if (t < cutoff) pluginRequestIds.delete(k)
  }
}

export const rememberPluginRequest = (id) => {
  pluginRequestIds.set(id, Date.now())
  if (pluginRequestIds.size > MAX_TRACKED_REQUESTS) {
    evictStaleRequests()
    // Everything is younger than the TTL: this is a genuine flood rather than a
    // leak, so fall back to dropping the oldest to keep the map bounded.
    if (pluginRequestIds.size > MAX_TRACKED_REQUESTS) {
      let drop = Math.floor(MAX_TRACKED_REQUESTS / 4)
      for (const k of pluginRequestIds.keys()) {
        pluginRequestIds.delete(k)
        if (--drop <= 0) break
      }
    }
  }
}

/** Test seam. Not used by the app. */
export const clearTrackedRequests = () => {
  pluginRequestIds.clear()
}

/** Test seam. Not used by the app. */
export const trackedRequestCount = () => pluginRequestIds.size

/**
 * Records which in-flight requests were initiated by a plugin frame.
 * Must be installed alongside disableXFrameOptions -- without it nothing is
 * attributable and the CORS relaxation below never applies (fails closed).
 *
 * This listener never cancels a request. It only records attribution, so plugin
 * network reach is exactly what it was before the lsp:// renderer.
 */
export const trackPluginFrameRequests = (win) => {
  // Registration must never abort app startup. This runs before *setup-fn is
  // assigned in core.cljs, so an exception here leaves the 'main' IPC channel
  // unregistered and the renderer dead on arrival -- the app opens and nothing
  // works. Degrade to "no attribution" (and therefore no CORS relaxation) rather
  // than taking the app down with us.
  try {
    installBeforeRequestTracker(win)
  } catch (e) {
    console.error('[plugin-cors] request tracker not installed:', e)
  }
}

const installBeforeRequestTracker = (win) => {
  // Filter to http(s) only. An unfiltered onBeforeRequest listener also sees the
  // renderer's own lsp:// asset loads and stalls them -- the app never finishes
  // starting. CORS only concerns http(s) anyway, so this is both the fix and the
  // correct scope.
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (d, c) => {
      let frameUrl = ''
      try {
        frameUrl = d.frame?.url || ''
        // A subframe navigation reports the not-yet-navigated CHILD frame as
        // d.frame -- its url is empty -- while the plugin that created the iframe
        // is d.frame.parent.
        if (!frameUrl && d.frame?.parent?.url) frameUrl = d.frame.parent.url
      } catch (e) {
        // frame already gone; treated as unattributable, i.e. not relaxed
      }

      if (isRelaxablePluginRequest({ frameUrl, resourceType: d.resourceType })) {
        rememberPluginRequest(d.id)
      }

      c({ cancel: false })
    }
  )
}

export const relaxCorsForPluginFrames = (d) => {
  // Fail closed: only requests positively attributed to a plugin frame at
  // onBeforeRequest time are relaxed. Not tracked -> leave the response alone.
  // NOTE: do NOT delete the entry here. onHeadersReceived fires again for each
  // hop of a redirect chain, and dropping it on the first response would leave
  // the final one unrelaxed. Entries expire by age instead.
  if (!pluginRequestIds.has(d.id)) return

  for (const k of Object.keys(d.responseHeaders)) {
    const lk = k.toLowerCase()
    if (
      lk === 'access-control-allow-origin' ||
      lk === 'access-control-allow-headers' ||
      lk === 'access-control-allow-methods' ||
      lk === 'access-control-expose-headers'
    ) {
      delete d.responseHeaders[k]
    }
  }

  d.responseHeaders['Access-Control-Allow-Origin'] = ['*']
  d.responseHeaders['Access-Control-Allow-Headers'] = ['*']
  d.responseHeaders['Access-Control-Allow-Methods'] = [
    'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD'
  ]
  // Without this a plugin can only read the six CORS-safelisted response headers.
  // Under file:// it could read all of them, so omitting this leaves a request
  // that "works" but whose Link/X-RateLimit/ETag headers have silently vanished.
  d.responseHeaders['Access-Control-Expose-Headers'] = ['*']
}
export const disableXFrameOptions = (win) => {
  win.webContents.session.webRequest.onHeadersReceived((d, c) => {
    relaxCorsForPluginFrames(d)

    if (d.responseHeaders['X-Frame-Options']) {
      delete d.responseHeaders['X-Frame-Options']
    }

    if (d.responseHeaders['x-frame-options']) {
      delete d.responseHeaders['x-frame-options']
    }

    if (d.responseHeaders['Content-Security-Policy']) {
      delete d.responseHeaders['Content-Security-Policy']
    }

    if (d.responseHeaders['content-security-policy']) {
      delete d.responseHeaders['content-security-policy']
    }

    c({ cancel: false, responseHeaders: d.responseHeaders })
  })
}

export async function getAllFiles(dir, exts) {
  const dirents = await fse.readdir(dir, { withFileTypes: true })

  if (exts != null) {
    !Array.isArray(exts) && (exts = [exts])

    exts = exts.map((it) => {
      if (typeof it === 'string' && it !== '' && !it.startsWith('.')) {
        it = '.' + it
      }

      return it?.toLowerCase()
    })
  }

  const files = await Promise.all(
    dirents.map(async (dirent) => {
      const filePath = path.resolve(dir, dirent.name)

      if (dirent.isDirectory()) {
        return getAllFiles(filePath, exts)
      }

      if (exts && !exts.includes(path.extname(dirent.name)?.toLowerCase())) {
        return null
      }

      const fileStats = await fse.lstat(filePath)

      return {
        path: filePath,
        size: fileStats.size,
        accessTime: fileStats.atimeMs,
        modifiedTime: fileStats.mtimeMs,
        changeTime: fileStats.ctimeMs,
        birthTime: fileStats.birthtimeMs
      }
    })
  )
  return files.flat().filter((it) => it != null)
}

export async function deepReadDir(dirPath, flat = true) {
  const ret = await Promise.all(
    (
      await fse.readdir(dirPath)
    ).map(async (entity) => {
      const root = path.join(dirPath, entity)
      return (await fse.lstat(root)).isDirectory()
        ? await deepReadDir(root)
        : root
    })
  )

  if (flat) {
    return ret?.flat()
  }

  return ret
}
