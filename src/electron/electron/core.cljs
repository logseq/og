(ns electron.core
  (:require [electron.handler :as handler]
            [electron.search :as search]
            [electron.updater :refer [init-updater] :as updater]
            [electron.utils :refer [*win mac? linux? dev? get-win-from-sender
                                    decode-protected-assets-schema-path get-graph-name send-to-renderer]
             :as utils]
            [electron.url :refer [logseq-url-handler]]
            [electron.logger :as logger]
            [electron.server :as server]
            [clojure.string :as string]
            [promesa.core :as p]
            [cljs-bean.core :as bean]
            [electron.configs :as cfgs]
            [electron.fs-watcher :as fs-watcher]
            ["fs" :as fs]
            ["path" :as node-path]
            ["electron" :refer [BrowserWindow Menu app protocol ipcMain dialog shell] :as electron]
            ["electron-deeplink" :refer [Deeplink]]
            [electron.state :as state]
            [electron.git :as git]
            [electron.window :as win]
            [electron.exceptions :as exceptions]
            ["/electron/utils" :as js-utils]
            [logseq.publishing.export :as publish-export]))

;; Keep same as main/frontend.util.url
(defonce LSP_SCHEME "logseq-og")
(defonce FILE_LSP_SCHEME "lsp")
(defonce FILE_ASSETS_SCHEME "assets")
(defonce LSP_PROTOCOL (str FILE_LSP_SCHEME "://"))
(defonce STATIC_URL (str LSP_PROTOCOL "logseq.com/"))
(defonce PLUGIN_HOST_URL (str LSP_PROTOCOL "logseq.io/"))
(defonce PLUGIN_URL (str PLUGIN_HOST_URL "plugins/"))
(defonce EXTERNAL_PLUGIN_URL (str LSP_PROTOCOL "logseq.io/external/"))
(defonce HOST_PLUGIN_URL (str STATIC_URL "plugins/"))
(defonce HOST_EXTERNAL_PLUGIN_URL (str STATIC_URL "external/"))
(defonce PLUGINS_ROOT (.join node-path cfgs/dot-root "plugins"))

(defonce *setup-fn (volatile! nil))
(defonce *teardown-fn (volatile! nil))
(defonce *quit-dirty? (volatile! true))

;; Handle creating/removing shortcuts on Windows when installing/uninstalling.
(when (js/require "electron-squirrel-startup") (.quit app))

(defn setup-updater! [^js win]
  ;; manual/auto updater
  (when-not linux?
    (init-updater {:repo   "logseq/logseq"
                   :win    win})))

(defn open-url-handler
  "win - the main window instance (first renderer process)
   url - the input URL"
  [win url]
  (logger/info "open-url" {:url url})
  ;; https://github.com/electron-userland/electron-builder/issues/1552
  ;; At macOS platform this is captured at 'open-url' event, we set it with deeplinkingUrl = url! (See // Protocol handler for osx)
  ;; At win32 platform this is saved at process.argv together with other arguments. To get only the provided url, deeplinkingUrl = argv.slice(1). (See // Protocol handler for win32)
  (when-let [parsed-url (try (js/URL. url)
                             (catch :default e
                               (logger/info "upon opening non-url" {:error e})))]
    (when (= (str LSP_SCHEME ":") (.-protocol parsed-url))
      (logseq-url-handler win parsed-url))))

(defn- seed-external-plugin-roots!
  "Tell the lsp:// handler which external plugin roots are legitimate.

   The external route serves from a directory named IN THE URL, so containment
   alone cannot decide whether that directory may be read at all -- a URL naming
   any path on disk would otherwise be served over the privileged lsp:// scheme.
   preferences.json's `externals` is the SDK's own record of the external plugins
   the user installed, so it is the right source of truth for \"which roots may be
   served from\", and js-utils adds the dot-root tmp dir the SDK generates plugin
   entry documents into.

   Called at startup and again whenever the handler meets a root it does not
   recognise, so a plugin installed mid-session does not have to wait for a
   restart to be served."
  []
  (let [prefs (.join node-path cfgs/dot-root "preferences.json")
        ^js json (try
                   (when (.existsSync fs prefs)
                     (js/JSON.parse (.toString (.readFileSync fs prefs))))
                   (catch :default e
                     (logger/warn ::seed-external-roots "could not read preferences.json" e)
                     nil))]
    (js-utils/seedPluginRoots
     (js-utils/pluginRootsFromPreferences cfgs/dot-root json))))

(defn setup-interceptor! [^js app]
  (.setAsDefaultProtocolClient app LSP_SCHEME)

  (.registerFileProtocol
   protocol FILE_ASSETS_SCHEME
   (fn [^js request callback]
     (let [url (.-url request)
           url (decode-protected-assets-schema-path url)
           path (string/replace url "assets://" "")
           path (js/decodeURIComponent path)]
       (cond (or (string/starts-with? path "/")
                 (re-find #"(?i)^/[a-zA-Z]:" path))
             (callback #js {:path path})

             ;; assume winwdows unc path
             utils/win32?
             (do (logger/debug :resolve-assets-url url)
                 (callback #js {:path (str "//" path)}))

             :else
             (do
               (logger/warn ::resolve-assets-url "Unknown assets url" url)
               (callback #js {:path path}))))))

  (.registerFileProtocol
   protocol FILE_LSP_SCHEME
   (fn [^js request callback]
     (let [url (.-url request)
           url' ^js (js/URL. url)
           external-plugin-url? (or (string/starts-with? url EXTERNAL_PLUGIN_URL)
                                    (string/starts-with? url HOST_EXTERNAL_PLUGIN_URL))
           ;; The whole logseq.io host is the plugins root, so accept the bare
           ;; legacy form (lsp://logseq.io/<pid>/...) alongside the namespaced
           ;; one. Themes register under the legacy form and their URLs are
           ;; persisted in preferences, so dropping it breaks every installed
           ;; theme on upgrade.
           plugin-url? (and (not external-plugin-url?)
                            (or (string/starts-with? url PLUGIN_HOST_URL)
                                (string/starts-with? url HOST_PLUGIN_URL)))
           path' (.-pathname url')
           ;; Every branch resolves through js-utils/resolveWithin, which returns
           ;; nil when the result would escape its root. Without it a decoded ".."
           ;; -- or, for the external form, an absolute path named directly in the
           ;; URL -- reads any file on disk through the privileged lsp:// scheme.
           ;; The traversal in the plugin branch predates this fork; the external
           ;; branch is ours, and is the wider hole of the two.
           path' (cond
                   plugin-url?
                   (-> path'
                       (utils/safe-decode-uri-component)
                       (string/replace-first #"^/plugins" "")
                       (#(js-utils/resolveWithin PLUGINS_ROOT %)))

                   external-plugin-url?
                   (let [external-path (subs path' (count "/external/"))
                         separator-index (string/index-of external-path "/")
                         encoded-root (if separator-index
                                        (subs external-path 0 separator-index)
                                        external-path)
                         relative-path (if separator-index
                                         (subs external-path separator-index)
                                         "")
                         root (utils/safe-decode-uri-component encoded-root)
                         relative-path (utils/safe-decode-uri-component relative-path)]
                     ;; An external root is only legitimate if a plugin actually
                     ;; loaded from it. Anything else is a URL naming a path it
                     ;; has no business reading. A root the startup seeding did not
                     ;; know about earns one re-read of preferences.json before it
                     ;; is refused -- that is how a plugin installed mid-session
                     ;; gets served.
                     (js-utils/resolveExternalPluginAsset
                      root relative-path seed-external-plugin-roots!))

                   :else
                   (-> path'
                       (utils/safe-decode-uri-component)
                       (#(js-utils/resolveWithin js/__dirname %))))]

       (if path'
         (callback #js {:path path'})
         (do
           (logger/warn ::lsp-protocol "Refused to serve out-of-root lsp:// url" url)
           ;; net::ERR_FILE_NOT_FOUND -- deliberately indistinguishable from a
           ;; genuinely missing file, so this is not a probe oracle.
           (callback #js {:error -6}))))))

  #(do
     (.unregisterProtocol protocol FILE_LSP_SCHEME)
     (.unregisterProtocol protocol FILE_ASSETS_SCHEME)))

(defn- handle-export-publish-assets [_event html repo-path asset-filenames output-path]
  (p/let [app-path (. app getAppPath)
          asset-filenames (->> (js->clj asset-filenames) (remove nil?))
          root-dir (or output-path (handler/open-dir-dialog))]
         (when root-dir
           (publish-export/create-export
            html
            app-path
            repo-path
            root-dir
            {:asset-filenames asset-filenames
             :log-error-fn logger/error
             :notification-fn #(send-to-renderer :notification %)}))))

(defn setup-app-manager!
  [^js win]
  (let [toggle-win-channel "toggle-max-or-min-active-win"
        call-app-channel "call-application"
        call-win-channel "call-main-win"
        export-publish-assets "export-publish-assets"
        quit-dirty-state "set-quit-dirty-state"
        clear-win-effects! (win/setup-window-listeners! win)]

    (doto ipcMain
      (.handle quit-dirty-state
               (fn [_ dirty?]
                 (vreset! *quit-dirty? (boolean dirty?))))

      (.handle toggle-win-channel
               (fn [_ toggle-min?]
                 (when-let [active-win (.getFocusedWindow BrowserWindow)]
                   (if toggle-min?
                     (if (.isMinimized active-win)
                       (.restore active-win)
                       (.minimize active-win))
                     (if (.isMaximized active-win)
                       (.unmaximize active-win)
                       (.maximize active-win))))))

      (.handle export-publish-assets handle-export-publish-assets)

      (.handle call-app-channel
               (fn [_ type & args]
                 (try
                   (js-invoke app type args)
                   (catch :default e
                     (logger/error (str call-app-channel " " e))))))

      (.handle call-win-channel
               (fn [^js e type & args]
                 (let [win (get-win-from-sender e)]
                   (try
                     (js-invoke win type args)
                     (catch :default e
                       (logger/error (str call-win-channel " " e))))))))

    #(do (clear-win-effects!)
         (.removeHandler ipcMain toggle-win-channel)
         (.removeHandler ipcMain export-publish-assets)
         (.removeHandler ipcMain quit-dirty-state)
         (.removeHandler ipcMain call-app-channel)
         (.removeHandler ipcMain call-win-channel))))

(defn- set-app-menu! []
  (let [about-fn (fn []
                   (.showMessageBox dialog (clj->js {:title "Logseq OG"
                                                     :icon (node-path/join js/__dirname "icons/logseq.png")
                                                     :message (str "Version " updater/electron-version)})))
        template (if mac?
                   [{:label (.-name app)
                     :submenu [{:role "about"}
                               {:type "separator"}
                               {:role "services"}
                               {:type "separator"}
                               {:role "hide"}
                               {:role "hideOthers"}
                               {:role "unhide"}
                               {:type "separator"}
                               {:role "quit"}]}]
                   [])
        template (conj template
                       {:role "fileMenu"
                        :submenu [{:label "New Window"
                                   :click (fn []
                                            (p/let [graph-name (get-graph-name (state/get-active-window-graph-path))
                                                    _ (handler/broadcast-persist-graph! graph-name)]
                                              (handler/open-new-window!)))
                                   :accelerator (if mac?
                                                  "CommandOrControl+N"
                                                  ;; Avoid conflict with `Control+N` shortcut to move down in the text editor on Windows/Linux
                                                  "Shift+CommandOrControl+N")}
                                  (if mac?
                                    ;; Disable Command+W shortcut
                                    {:role "close"
                                     :accelerator false}
                                    {:role "quit"})]}
                       {:role "editMenu"}
                       {:role "viewMenu"}
                       {:role "windowMenu"
                        :submenu (when-not mac? [{:role "minimize"}
                                                 {:role "zoom"}
                                                 ;; Disable Control+W shortcut
                                                 {:role "close"
                                                  :accelerator false}])})
        ;; Windows has no about role
        template (conj template
                       (if mac?
                         {:role "help"
                          :submenu [{:label "Official Documentation"
                                     :click #(.openExternal shell "https://docs.logseq.com/")}]}
                         {:role "help"
                          :submenu [{:label "Official Documentation"
                                     :click #(.openExternal shell "https://docs.logseq.com/")}
                                    {:role "about"
                                     :label "About Logseq"
                                     :click about-fn}]}))
        ;; Enable Cmd/Ctrl+= Zoom In
        template (conj template
                       {:role "zoomin"
                        :accelerator "CommandOrControl+="})
        menu (.buildFromTemplate Menu (clj->js template))]
    (.setApplicationMenu Menu menu)))

(defn- setup-deeplink! []
  ;; Works for Deeplink v1.0.9
  ;; :mainWindow is only used for handling window restoring on second-instance,
  ;; But we already handle window restoring without deeplink.
  ;; https://github.com/glawson/electron-deeplink/blob/73d58edcde3d0e80b1819cd68a0c6e837a9c9258/src/index.ts#L150-L155
  (-> (Deeplink. #js
                  {:app app
                   :mainWindow nil
                   :protocol LSP_SCHEME
                   :isDev dev?})
      (.on "received"
           (fn [url]
             (when-let [win @*win]
               (open-url-handler win url))))))

(defn main []
  (if-not (.requestSingleInstanceLock app)
    (do
      (search/close!)
      (.quit app))
    (let [privileges {:standard        true
                      :secure          true
                      :bypassCSP       true
                      :supportFetchAPI true}]
      (.registerSchemesAsPrivileged
       protocol (bean/->js [{:scheme     LSP_SCHEME
                             :privileges privileges}
                            {:scheme     FILE_LSP_SCHEME
                             :privileges privileges}
                            {:scheme     FILE_ASSETS_SCHEME
                             :privileges {:standard        false
                                          :secure          false
                                          :bypassCSP       false
                                          :supportFetchAPI false}}]))

      (set-app-menu!)
      (setup-deeplink!)

      (.on app "second-instance"
           (fn [_event _commandLine _workingDirectory]
             (when-let [window @*win]
               (win/switch-to-window! window))))

      (.on app "window-all-closed" (fn []
                                     (logger/debug "window-all-closed" "Quitting...")
                                     (try
                                       (fs-watcher/close-watcher!)
                                       (search/close!)
                                       (catch :default e
                                         (logger/error "window-all-closed" e)))
                                     (.quit app)))
      (.on app "ready"
           (fn []
             (let [t0 (setup-interceptor! app)
                   ^js win (win/create-main-window!)
                   _ (reset! *win win)]
               (logger/info (str "Logseq App(" (.getVersion app) ") Starting... "))

               (utils/<restore-proxy-settings)

               (logger/info
                (str "External plugin roots seeded for lsp://: "
                     (seed-external-plugin-roots!)))

               ;; Must be installed before disableXFrameOptions: it attributes
               ;; in-flight requests to plugin frames, and the CORS relaxation in
               ;; that listener fails closed on anything it cannot attribute.
               (js-utils/trackPluginFrameRequests win)

               (js-utils/disableXFrameOptions win)

               (search/ensure-search-dir!)

               (search/open-dbs!)

               (git/configure-auto-commit!)

               (vreset! *setup-fn
                        (fn []
                          (let [t1 (setup-updater! win)
                                t2 (setup-app-manager! win)
                                t3 (handler/set-ipc-handler! win)
                                t4 (server/setup! win)
                                tt (exceptions/setup-exception-listeners!)]

                            (vreset! *teardown-fn
                                     #(doseq [f [t0 t1 t2 t3 t4 tt]]
                                        (and f (f)))))))

               ;; setup effects
               (@*setup-fn)

               ;; main window events
               (.on win "close" (fn [e]
                                  (git/before-graph-close-hook!)
                                  (when @*quit-dirty? ;; when not updating
                                    (.preventDefault e)

                                    (let [windows (win/get-all-windows)
                                          window @*win
                                          multiple-windows? (> (count windows) 1)]
                                      (cond
                                        (or multiple-windows? (not mac?) @win/*quitting?)
                                        (when window
                                          (win/close-handler win handler/close-watcher-when-orphaned! e)
                                          (reset! *win nil))

                                        (and mac? (not multiple-windows?))
                                        ;; Just hiding - don't do any actual closing operation
                                        (do (.preventDefault ^js/Event e)
                                            (if (and mac? (.isFullScreen win))
                                              (do (.once win "leave-full-screen" #(.hide win))
                                                  (.setFullScreen win false))
                                              (.hide win)))
                                        :else
                                        nil)))))
               (.on app "before-quit" (fn [_e]
                                        (reset! win/*quitting? true)))

               (.on app "activate" #(when @*win (.show win)))))))))

(defn start []
  (logger/debug "Main - start")
  (when @*setup-fn (@*setup-fn)))

(defn stop []
  (logger/debug "Main - stop")
  (when @*teardown-fn (@*teardown-fn)))
