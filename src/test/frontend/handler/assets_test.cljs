(ns frontend.handler.assets-test
  "Guards the protocol `normalize-asset-resource-url` builds local asset URLs with.

   On Electron it must be assets://, never file://. The renderer document is
   served over the privileged lsp:// scheme, and Chromium refuses a file://
   subresource from that origin: an <img> fails silently and pdf.js reports the
   blocked read as `Missing PDF \"file:///...pdf\"`, which reads as a deleted
   file. The scheme half of the contract -- that an assets:// URL is actually
   fetchable from the renderer's origin -- is asserted against a real Electron
   in test/electron-js/asset-protocol.test.mjs."
  (:require [cljs.test :refer [deftest testing is]]
            [clojure.string :as string]
            [frontend.config :as config]
            [frontend.handler.assets :as assets-handler]
            [frontend.state :as state]
            [frontend.util :as util]))

(def ^:private graph-dir "/home/nils/Logseq")

(defn- with-electron
  "Run f as if the app were the desktop renderer."
  [f]
  (with-redefs [util/electron?       (constantly true)
                state/get-current-repo (constantly (str "logseq_local_" graph-dir))
                config/get-repo-dir  (constantly graph-dir)]
    (f)))

(deftest normalize-asset-resource-url-on-electron
  (testing "a relative asset path -- the shape the PDF viewer passes"
    ;; pdf/assets.cljs inflate-asset builds "../assets/<key>.pdf" for a
    ;; highlighted PDF page, so this is the exact path the reported bug took.
    (with-electron
      #(is (= (str "assets://" graph-dir "/assets/a.pdf")
              (assets-handler/normalize-asset-resource-url "../assets/a.pdf")))))

  (testing "an absolute asset path"
    (with-electron
      #(is (= (str "assets://" graph-dir "/assets/a.pdf")
              (assets-handler/normalize-asset-resource-url (str graph-dir "/assets/a.pdf"))))))

  (testing "a percent-encoded path stays encoded exactly once"
    ;; The URL stays percent-encoded, and the main process decodes it once
    ;; (js-utils/resolveAssetsSchemeUrl). The decode step inside
    ;; normalize-asset-resource-url is NOT there to produce a literal space: it
    ;; cancels the re-encoding that path/url-join does for a file-like URL
    ;; (path/is-file-url? lists assets:// as "Electron asset, urlencoded"), so an
    ;; already-encoded input does not come back DOUBLE-encoded as %2520 -- which
    ;; would reach the handler as a literal "%20" in the filename and miss.
    (with-electron
      #(is (= (str "assets://" graph-dir "/assets/my%20file.pdf")
              (assets-handler/normalize-asset-resource-url (str graph-dir "/assets/my%20file.pdf"))))))

  (testing "an unencoded space is encoded once, so the handler's decode recovers it"
    (with-electron
      #(is (= (str "assets://" graph-dir "/assets/my%20file.pdf")
              (assets-handler/normalize-asset-resource-url (str graph-dir "/assets/my file.pdf"))))))

  (testing "no local asset URL is built with the file:// protocol"
    (with-electron
      #(doseq [path ["../assets/a.pdf"
                     "assets/a.pdf"
                     (str graph-dir "/assets/a.pdf")]]
         (is (not (string/starts-with?
                   (assets-handler/normalize-asset-resource-url path) "file://"))
             (str "built a file:// URL for " path
                  " -- blocked from the lsp:// renderer origin"))))))

(deftest normalize-asset-resource-url-passes-through-real-urls
  (testing "an existing protocol link is returned untouched"
    (with-electron
      #(doseq [url ["https://x.com/a.pdf"
                    "http://x.com/a.pdf"
                    "assets:///already/resolved.pdf"]]
         (is (= url (assets-handler/normalize-asset-resource-url url)))))))
