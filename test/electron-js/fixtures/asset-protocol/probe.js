// Runs in the MAIN renderer, at the app's real origin (lsp://logseq.com).
//
// Every probe is an XHR because that is what pdf.js uses for a non-http(s) URL
// (pdfjs-dist's isValidFetchUrl accepts only http/https), and the bug this
// suite guards was a blocked XHR surfacing as `Missing PDF "file://..."`.
const params = new URLSearchParams(location.search)
const IN_ROOT = params.get('in')
const OUTSIDE = params.get('out')
const TRAVERSAL = params.get('trav')
const STYLESHEET = params.get('css')

function xhrProbe (url) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    try {
      xhr.open('GET', url)
    } catch (e) {
      return resolve({ url, threw: String(e), status: -1, bytes: 0 })
    }
    xhr.responseType = 'arraybuffer'
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4) return
      resolve({ url, status: xhr.status, bytes: xhr.response ? xhr.response.byteLength : 0 })
    }
    try {
      xhr.send()
    } catch (e) {
      resolve({ url, threw: String(e), status: -1, bytes: 0 })
    }
  })
}

// A plugin frame is the boundary root containment defends: assets:// is
// corsEnabled, so without containment any plugin frame could read any file on
// disk by naming it in a URL.
function pluginFrameReport () {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 8000)
    window.addEventListener('message', (e) => {
      clearTimeout(timer)
      resolve(e.data)
    })
    const frame = document.createElement('iframe')
    frame.src = 'lsp://logseq.com/plugins/frame.html' + location.search
    document.body.appendChild(frame)
  })
}

// A plugin theme is injected as <link rel=stylesheet> pointing at an asset
// (SDK LSPlugin.core.ts _loadConfigThemes). It has to load AND apply, and its
// own relative url() references have to resolve, or the theme silently does
// nothing -- which is what happened while that URL was rewritten to file://.
function stylesheetProbe (href) {
  return new Promise((resolve) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    const done = (event) => resolve({
      event,
      applied: getComputedStyle(document.body).getPropertyValue('--asset-protocol-probe').trim() || null,
      relativeUrl: getComputedStyle(document.body).backgroundImage
    })
    link.onload = () => done('load')
    link.onerror = () => done('error')
    document.head.appendChild(link)
    setTimeout(() => done('timeout'), 5000)
  })
}

;(async () => {
  const result = {
    rendererOrigin: location.origin,
    mainFrame: {
      assetsInRoot: await xhrProbe('assets://' + IN_ROOT),
      assetsOutOfRoot: await xhrProbe('assets://' + OUTSIDE),
      assetsTraversal: await xhrProbe('assets://' + TRAVERSAL),
      fileInRoot: await xhrProbe('file://' + IN_ROOT),
      stylesheetInRoot: await stylesheetProbe('assets://' + STYLESHEET)
    },
    pluginFrame: await pluginFrameReport()
  }
  console.log('ASSET_PROTOCOL_RESULT ' + JSON.stringify(result))
})()
