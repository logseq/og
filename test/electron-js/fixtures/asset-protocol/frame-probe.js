// Runs in a PLUGIN frame (lsp://logseq.com/plugins/...). See probe.js for why
// this frame matters. Measured separately: a plugin frame receives no preload
// bridge, so assets:// is its only route to a local file.
const params = new URLSearchParams(location.search)
const IN_ROOT = params.get('in')
const OUTSIDE = params.get('out')

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

;(async () => {
  parent.postMessage({
    origin: location.origin,
    assetsInRoot: await xhrProbe('assets://' + IN_ROOT),
    assetsOutOfRoot: await xhrProbe('assets://' + OUTSIDE)
  }, '*')
})()
