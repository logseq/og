(ns electron.state
  (:require ["/electron/utils" :as js-utils]
            [clojure.core.async :as async]
            [clojure.string :as string]
            [electron.configs :as config]
            [medley.core :as medley]))

(defonce persistent-dbs-chan (async/chan 1))

(defonce state
  (atom {:config (config/get-config)

         ;; window -> current graph
         :window/graph {}

         ;; job to do when persistGraph is done on renderer
         :window/once-persist-done nil

         ;; job to do when graph is loaded on renderer
         :window/once-graph-ready nil}))

(defn set-state!
  [path value]
  (if (vector? path)
    (swap! state assoc-in path value)
    (swap! state assoc path value)))

(defn get-git-commit-seconds
  []
  (get-in @state [:config :git/auto-commit-seconds] 60))

(defn git-auto-commit-enabled?
  []
  ;; For backward compatibility, use negative logic
  (false? (get-in @state [:config :git/disable-auto-commit?] true)))

(defn git-commit-on-close-enabled?
  []
  (get-in @state [:config :git/commit-on-close?] false))

(defn get-window-graph-path
  "Get the path of the graph of a window (might be `nil`)"
  [window]
  (get (:window/graph @state) window))

(defn get-all-graph-paths
  "Get the paths of all graphs currently open in all windows."
  []
  (set (vals (:window/graph @state))))

(defn reseed-asset-roots!
  "Tell the assets:// handler which directories it may serve from.

   Two sources, both of them the user's own choice:
   - every graph currently open, which main learns first-hand in
     `set-current-graph!`;
   - the asset alias directories picked in Settings, which live in renderer
     storage and reach main over `:setAssetsAliasDirs`. They are mirrored into
     main's own configs.edn so the roots are known at startup, BEFORE the
     renderer gets a chance to push them -- otherwise the first render after a
     relaunch would race the seeding and an alias image would fail for no
     visible reason.

   Called on every change rather than diffed: the set is a handful of strings.
   Lives here rather than in electron.handler so electron.window can call it on
   close too -- handler already requires window, so window cannot require
   handler. See ASSETS_SCHEME_PRIVILEGES in utils.js for why this matters.

   ORDERING. At startup the graph set is empty, so the count logged is 0 and an
   assets:// request would be refused. Nothing races it, and not by luck: the
   renderer sends :setCurrentGraph while frontend.state's ns initialises, and an
   asset request cannot be ISSUED until blocks render, which needs the graph's
   DB loaded over later IPC calls on the same ordered channel. If that ever
   changes, the symptom is a `Refused out-of-root assets:// url` warning right
   after launch -- which is why the refusal is logged rather than silent."
  []
  (let [roots (->> (concat (get-all-graph-paths)
                           (config/get-item :assets/alias-roots))
                   (filter string?)
                   (remove string/blank?)
                   (distinct))]
    (js-utils/seedAssetRoots (clj->js roots))))

(defn get-active-window-graph-path
  "Get the path of the graph of the currently focused window (might be `nil`)"
  []
  (let [windows (:window/graph @state)
        active-windows-pairs (filter #(.isFocused (first %)) windows)
        active-window-pair (first active-windows-pairs)
        path (second active-window-pair)]
    path)
  )

(defn close-window!
  [window]
  (swap! state medley/dissoc-in [:window/graph window]))
