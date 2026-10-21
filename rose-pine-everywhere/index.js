(function () {
  "use strict";
  // Rosé Pine Everywhere V4 — EXPERIMENTAL / REVERSIBLE
  // This plugin only inspects already-initialized modules; it never sends logs anywhere.
  const CONFIG = {
    wallpaperUrl: "https://raw.githubusercontent.com/rose-pine/discord-mobile/main/Assets/V06yN.png",
    overlayOpacity: 0.35,
    imageBlur: 0
  };
  const TARGETS = [
    "GuildChannelList", "GuildChannelListConnected", "GuildChannelListScreen",
    "GuildChannelListContainer", "GuildChannels", "GuildChannelsScreen",
    "GuildChannelsContainer", "GuildChannelsView", "ChannelList",
    "ChannelListConnected", "ChannelDrawer", "ChannelDrawerContent",
    "ChannelsList", "ServerChannelList", "GuildSidebar", "GuildsBar",
    "SettingsScreen", "SettingsOverview", "UserSettingsOverview"
  ];
  const targetSet = new Set(TARGETS);
  const state = {
    api: null, React: null, RN: null, live: false,
    unpatches: [], identities: new Set(), targetsPatched: [],
    patchCalls: 0, overlayRenders: 0,
    scan: { registry: "Not scanned", initialized: 0, examined: 0, names: [],
      finder: "Not checked", finderMatches: [], errors: [] }
  };
  function logger(s, e) { try { console.log("[RosePineEverywhere V4]", s, e || ""); } catch (_) {} }
  function storage(key, fallback) {
    try { return state.api.plugin.storage[key] === undefined ? fallback : state.api.plugin.storage[key]; }
    catch (_) { return fallback; }
  }
  function imageUrl() {
    const s = storage("wallpaperUrl", CONFIG.wallpaperUrl);
    return typeof s === "string" && /^https:\/\//i.test(s) ? s : CONFIG.wallpaperUrl;
  }
  function overlay() {
    const n = Number(storage("overlayOpacity", CONFIG.overlayOpacity));
    return Number.isFinite(n) ? Math.max(0, Math.min(0.85, n)) : 0.35;
  }
  function wrap(result) {
    if (!state.live || !state.React || !state.RN || !state.React.isValidElement(result)) return result;
    const R = state.React, RN = state.RN;
    try {
      const child = result.props && result.props.style != null
        ? R.cloneElement(result, { style: [result.props.style, { backgroundColor: "transparent" }] })
        : result;
      state.overlayRenders++;
      return R.createElement(RN.ImageBackground, {
        source: { uri: imageUrl() }, style: { flex: 1 }, imageStyle: { opacity: 1 },
        resizeMode: "cover", blurRadius: CONFIG.imageBlur, pointerEvents: "box-none"
      }, R.createElement(RN.View, {
        style: { flex: 1, backgroundColor: "rgba(25,23,36," + overlay() + ")" },
        pointerEvents: "box-none"
      }, child));
    } catch (err) { state.scan.errors.push("Wallpaper render: " + String(err).slice(0, 110)); return result; }
  }
  function getName(value) {
    try {
      if (value == null) return "";
      if (typeof value.displayName === "string") return value.displayName;
      if (typeof value === "function") return value.name || "";
      if (typeof value === "object") {
        if (typeof value.type === "function") return getName(value.type);
        if (typeof value.render === "function") return getName(value.render);
      }
    } catch (_) {}
    return "";
  }
  function safeName(name) {
    return typeof name === "string" && name.length < 90 && /^[A-Z]/.test(name) &&
      /(guild|channel|drawer|navigation|settings|screen|sidebar|panel)/i.test(name) &&
      !/^(get|set|should|handle|create|update|transition|default|use|open|close)/i.test(name);
  }
  function patch(parent, key, name, id) {
    const identity = String(id) + ":" + key + ":" + name;
    if (state.identities.has(identity) || !parent || typeof parent[key] !== "function") return;
    try {
      // Classic Revenge/Vendetta (spitroast) signature: after(methodName, parent, callback)
      const undo = state.api.patcher.after(key, parent, function (_args, result) {
        state.patchCalls++;
        return wrap(result);
      });
      if (typeof undo === "function") {
        state.unpatches.push(undo);
        state.identities.add(identity);
        state.targetsPatched.push(name);
      }
    } catch (error) { state.scan.errors.push(name + ": " + String(error).slice(0, 100)); }
  }
  function getRegistry() {
    const candidates = [];
    try { candidates.push(["globalThis.modules", globalThis.modules]); } catch (_) {}
    try { candidates.push(["vendetta.metro.modules", state.api.metro.modules]); } catch (_) {}
    for (const [name, value] of candidates) {
      if (!value) continue;
      try {
        const size = value instanceof Map ? value.size : Object.keys(value).length;
        if (size) return { name, value, size };
      } catch (_) {}
    }
    return null;
  }
  function scan() {
    const rec = state.scan;
    rec.registry = "Unavailable"; rec.initialized = 0; rec.examined = 0;
    rec.names = []; rec.finderMatches = []; rec.errors = [];
    const nameSet = new Set();
    const registry = getRegistry();
    if (!registry) { rec.errors.push("Metro registry not available"); return; }
    rec.registry = registry.name;
    const entries = registry.value instanceof Map ? registry.value.entries() : Object.entries(registry.value);
    for (const [id, entry] of entries) {
      let exported;
      try {
        if (!entry || entry.isInitialized === false || !entry.publicModule) continue;
        exported = entry.publicModule.exports;
      } catch (_) { continue; }
      if (!exported) continue;
      rec.initialized++;
      const seen = new Set();
      function inspect(value, owner, key, depth) {
        if (!value || depth > 3 || seen.has(value)) return;
        if (typeof value !== "function" && typeof value !== "object") return;
        seen.add(value);
        const name = getName(value);
        if (name) {
          rec.examined++;
          if (safeName(name) && nameSet.size < 180) nameSet.add(name);
          if (targetSet.has(name) && typeof value === "function") patch(owner, key, name, id);
        }
        // Crucial V4 fix: inspect memo/forwardRef internals and their export holders.
        // Avoid traversing arbitrary Discord objects or requiring any new modules.
        if (typeof value === "object" && depth < 3) {
          try { if (value.type) inspect(value.type, value, "type", depth + 1); } catch (_) {}
          try { if (value.render) inspect(value.render, value, "render", depth + 1); } catch (_) {}
          try { if (value.default) inspect(value.default, value, "default", depth + 1); } catch (_) {}
        }
      }
      try {
        if (typeof exported === "function") inspect(exported, entry.publicModule, "exports", 0);
        else if (typeof exported === "object") {
          const keys = Object.keys(exported);
          if (keys.length < 50) for (const k of keys) {
            let child;
            try { child = exported[k]; } catch (_) { continue; }
            if (typeof child === "function" || (child && typeof child === "object" && (child.type || child.render))) {
              inspect(child, exported, k, 0);
            }
          }
        }
      } catch (_) {}
    }
    rec.names = [...nameSet].sort((a,b)=>{
      const rank = s => /channel/i.test(s) ? 0 : /drawer|sidebar/i.test(s) ? 1 : /guild/i.test(s) ? 2 : 3;
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    // The Classic finder can locate React memo wrappers not visible via name lookup.
    const metro = state.api && state.api.metro;
    const finder = metro && metro.findByTypeNameAll;
    rec.finder = typeof finder === "function" ? "findByTypeNameAll available" : "findByTypeNameAll unavailable";
    if (typeof finder === "function") {
      for (const query of ["GuildsBar", "GuildsBarGuild", "GuildChannelList", "ChannelDrawer", "ChannelList", "GuildSidebar"]) {
        try {
          const found = finder(query);
          const n = Array.isArray(found) ? found.length : found && typeof found[Symbol.iterator] === "function" ? [...found].length : found ? 1 : 0;
          if (n > 0) rec.finderMatches.push(query + " (" + n + ")");
        } catch (e) { rec.errors.push("Finder " + query + ": " + String(e).slice(0, 70)); }
      }
    }
    logger("Scan: " + rec.initialized + " initialized, " + state.targetsPatched.length + " patches, " + rec.finderMatches.length + " finder types");
  }
  function Settings() {
    const R = state.React, RN = state.RN;
    const [url, setUrl] = R.useState(imageUrl());
    const [opacity, setOpacity] = R.useState(String(overlay()));
    const [count, setCount] = R.useState(0);
    const [status, setStatus] = R.useState("V4 loaded. Open a server and tap Rescan.");
    const [showMore, setShowMore] = R.useState(false);
    const textStyle = { color: "#e0def4", fontSize: 14, marginTop: 10 };
    const inputStyle = { color: "#e0def4", backgroundColor: "#26233a", padding: 12, borderRadius: 9, marginTop: 8 };
    const Touch = RN.TouchableOpacity || RN.Pressable;
    function line(key, text) { return R.createElement(RN.Text, { key, selectable: true, style: textStyle }, text); }
    function button(key, label, fn) {
      return R.createElement(Touch, { key, onPress: () => { setCount(n=>n+1); try { fn(); } catch(e) { setStatus("Error: " + String(e).slice(0, 120)); } },
        style: { backgroundColor: "#c4a7e7", padding: 14, borderRadius: 9, marginTop: 14 } },
      R.createElement(RN.Text, { style: { color: "#191724", textAlign: "center", fontWeight: "bold" } }, label));
    }
    return R.createElement(RN.ScrollView, { style: { flex: 1, backgroundColor: "#191724" },
      contentContainerStyle: { padding: 18, paddingBottom: 80 }, keyboardShouldPersistTaps: "always" },
      R.createElement(RN.Text, { style: { fontSize: 19, fontWeight: "bold", color: "#e0def4" } }, "Rosé Pine Everywhere — V4 diagnostic"),
      line("status", status + " | Buttons pressed: " + count),
      line("registry", "Registry: " + state.scan.registry + ", initialized: " + state.scan.initialized + ", examined: " + state.scan.examined),
      line("patches", "Patches installed: " + state.targetsPatched.length + " | Patch calls: " + state.patchCalls + " | Wallpaper renders: " + state.overlayRenders),
      line("finder", "Classic type finder: " + state.scan.finder),
      line("finderMatch", "Finder matches: " + (state.scan.finderMatches.join(", ") || "NONE")),
      line("matching", "Patched component names: " + (state.targetsPatched.join(", ") || "NONE")),
      line("candidate", "Potential channel/screen components: " + (state.scan.names.slice(0, 18).join(", ") || "NONE")),
      line("errors", "Errors: " + (state.scan.errors.slice(0, 3).join("; ") || "none")),
      button("rescan", "Rescan loaded screens", () => {
        scan(); setStatus("Rescan finished; " + state.scan.names.length + " candidate names, " + state.targetsPatched.length + " patches.");
      }),
      button("details", showMore ? "Hide additional component names" : "Show additional component names", () => setShowMore(v=>!v)),
      showMore ? line("more", state.scan.names.slice(18, 70).join(", ") || "No additional matches") : null,
      line("help", "V4 finds wrapped React components. Zero installed patches means the correct screens still haven't been found. A positive patch count with zero calls means the patched export isn't being invoked."),
      line("label-url", "Wallpaper URL (HTTPS)"),
      R.createElement(RN.TextInput, { style: inputStyle, multiline: true, value: url, onChangeText: setUrl, autoCapitalize: "none", autoCorrect: false }),
      line("label-opacity", "Dark overlay (0.0–0.85)"),
      R.createElement(RN.TextInput, { style: inputStyle, value: opacity, onChangeText: setOpacity, keyboardType: "decimal-pad" }),
      button("save", "Save wallpaper settings", () => {
        if (!/^https:\/\/\S+$/i.test(url.trim())) { setStatus("Invalid wallpaper URL"); return; }
        const n = Number(opacity); if (!Number.isFinite(n)) { setStatus("Overlay must be a number"); return; }
        try {
          state.api.plugin.storage.wallpaperUrl = url.trim();
          state.api.plugin.storage.overlayOpacity = Math.max(0, Math.min(0.85, n));
          setStatus("Saved. Reload Revenge to apply.");
        } catch (e) { setStatus("Storage error: " + String(e).slice(0, 90)); }
      }),
      line("disclaimer", "Experimental: no guaranteed full-app wallpaper. No account data is collected or transmitted. Disable the plugin to restore the original screens.")
    );
  }
  return {
    onLoad: function () {
      try {
        state.api = vendetta;
        state.React = vendetta.metro.common.React || globalThis.React;
        state.RN = vendetta.metro.common.ReactNative;
        if (!state.React || !state.RN || !state.RN.ImageBackground || !vendetta.patcher || typeof vendetta.patcher.after !== "function") {
          state.scan.errors.push("Required Revenge Classic APIs unavailable"); return;
        }
        state.live = true; scan();
      } catch (e) { state.live = false; state.scan.errors.push("Initialization: " + String(e).slice(0, 100)); }
    },
    onUnload: function () {
      state.live = false;
      while (state.unpatches.length) try { state.unpatches.pop()(); } catch (_) {}
      state.identities.clear(); state.targetsPatched = [];
    },
    settings: Settings
  };
})()
