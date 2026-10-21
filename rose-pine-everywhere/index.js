(function () {
  "use strict";
  // ==============================================
  // PERSONALIZE THESE DEFAULTS
  // ==============================================
  const CONFIG = {
    wallpaperUrl: "https://raw.githubusercontent.com/rose-pine/discord-mobile/main/Assets/V06yN.png",
    overlayOpacity: 0.35,
    imageBlur: 0,
    verboseLogging: false
  };
  // ==============================================

  const TARGETS = new Set([
    "GuildChannelList", "GuildChannelListConnected", "GuildChannelListScreen",
    "GuildChannels", "GuildChannelsConnected", "GuildChannelsScreen",
    "ChannelList", "ChannelListConnected", "ChannelDrawer", "ChannelDrawerContent",
    "ChannelsList", "ServerChannelList", "GuildSidebar", "GuildsBar",
    "SettingsScreen", "SettingsOverview", "UserSettingsOverview", "SettingsNavigator",
    "GuildChannelsView", "GuildChannelsContainer", "GuildChannelListContainer"
  ]);

  let enabled = false;
  let api = null;
  let React = null;
  let RN = null;
  const unpatches = [];
  const patchedKeys = new Set();
  const stats = {
    registry: "Not checked",
    total: 0,
    initialized: 0,
    components: 0,
    matches: [],
    candidates: [],
    errors: []
  };

  function log(message, error) {
    try { console.log("[RosePineEverywhere V3]", message, error || ""); } catch (_) {}
  }
  function setting(name, fallback) {
    try {
      const storage = api && api.plugin && api.plugin.storage;
      return storage && storage[name] !== undefined ? storage[name] : fallback;
    } catch (_) { return fallback; }
  }
  function wallpaperUrl() {
    const url = setting("wallpaperUrl", CONFIG.wallpaperUrl);
    return typeof url === "string" && /^https:\/\//i.test(url.trim()) ? url.trim() : CONFIG.wallpaperUrl;
  }
  function overlayOpacity() {
    const value = Number(setting("overlayOpacity", CONFIG.overlayOpacity));
    return Number.isFinite(value) ? Math.max(0, Math.min(0.85, value)) : CONFIG.overlayOpacity;
  }
  function makeTransparent(element) {
    if (!React.isValidElement(element) || !element.props || element.props.style == null) return element;
    try {
      return React.cloneElement(element, { style: [element.props.style, { backgroundColor: "transparent" }] });
    } catch (_) { return element; }
  }
  function wallpaperBehind(element) {
    if (!enabled || !React || !RN || !RN.ImageBackground || !React.isValidElement(element)) return element;
    try {
      return React.createElement(RN.ImageBackground, {
        source: { uri: wallpaperUrl() },
        style: { flex: 1 },
        imageStyle: { opacity: 1 },
        resizeMode: "cover",
        blurRadius: CONFIG.imageBlur,
        pointerEvents: "box-none"
      }, React.createElement(RN.View, {
        style: { flex: 1, backgroundColor: "rgba(25,23,36," + overlayOpacity() + ")" },
        pointerEvents: "box-none"
      }, makeTransparent(element)));
    } catch (err) {
      if (CONFIG.verboseLogging) log("Wallpaper render failed", err);
      return element;
    }
  }

  function functionName(value) {
    try {
      if (!value) return "";
      if (typeof value === "function") return value.displayName || value.name || "";
      if (typeof value === "object") {
        if (typeof value.displayName === "string") return value.displayName;
        if (typeof value.type === "function") return functionName(value.type);
        if (typeof value.render === "function") return functionName(value.render);
      }
    } catch (_) {}
    return "";
  }

  // Vendetta/Bunny exposes its Metro registry in different places depending
  // on the loaded bundle. Original v1 only checked vendetta.metro.modules.
  function getRegistry() {
    const candidates = [];
    try { candidates.push(["globalThis.modules", globalThis.modules]); } catch (_) {}
    try { candidates.push(["vendetta.metro.modules", api.metro.modules]); } catch (_) {}
    try { candidates.push(["globalThis.window.modules", globalThis.window && globalThis.window.modules]); } catch (_) {}
    for (const [name, registry] of candidates) {
      try {
        if (registry && (typeof registry === "object" || registry instanceof Map)) {
          const size = registry instanceof Map ? registry.size : Object.keys(registry).length;
          if (size > 0) return { name, registry, size };
        }
      } catch (_) {}
    }
    return null;
  }

  function patch(parent, key, name, id) {
    if (!enabled || !api || !api.patcher || typeof api.patcher.after !== "function") return;
    const idKey = String(id) + ":" + key + ":" + name;
    if (patchedKeys.has(idKey)) return;
    try {
      if (!parent || typeof parent[key] !== "function") return;
      const undo = api.patcher.after(key, parent, function (_args, result) {
        return wallpaperBehind(result);
      });
      if (typeof undo === "function") {
        unpatches.push(undo);
        patchedKeys.add(idKey);
        stats.matches.push(name);
      }
    } catch (e) {
      stats.errors.push(name + ": " + String(e).slice(0, 90));
    }
  }

  function examineFunction(parent, key, id) {
    let fn;
    try { fn = parent[key]; } catch (_) { return; }
    if (!fn) return;
    const name = functionName(fn);
    if (!name) return;
    stats.components++;
    if (/^[A-Z]/.test(name) && /(channel|guild|sidebar|drawer|settings|screen|panel|list|navigation)/i.test(name)) {
      if (stats.candidates.indexOf(name) === -1 && stats.candidates.length < 70) stats.candidates.push(name);
    }
    if (TARGETS.has(name)) {
      patch(parent, key, name, id);
    }
    // React.memo and React.forwardRef may wrap the real screen function.
    try {
      if (fn && typeof fn === "object" && typeof fn.type === "function") {
        const innerName = functionName(fn.type);
        if (TARGETS.has(innerName)) patch(fn, "type", innerName, id);
      }
      if (fn && typeof fn === "object" && typeof fn.render === "function") {
        const renderName = functionName(fn.render);
        if (TARGETS.has(renderName)) patch(fn, "render", renderName, id);
      }
    } catch (_) {}
  }

  function scan() {
    stats.total = 0;
    stats.initialized = 0;
    stats.components = 0;
    stats.candidates = [];
    stats.errors = [];
    stats.matches = Array.from(patchedKeys).map(k => k.split(":").slice(2).join(":"));
    const found = getRegistry();
    if (!found) {
      stats.registry = "Unavailable (neither globalThis.modules nor vendetta.metro.modules)";
      log("Metro registry not exposed. No patches applied.");
      return;
    }
    stats.registry = found.name;
    stats.total = found.size;
    const entries = found.registry instanceof Map ? found.registry.entries() : Object.entries(found.registry);
    for (const [id, entry] of entries) {
      let exports;
      try {
        if (!entry || entry.isInitialized === false) continue;
        exports = entry.publicModule && entry.publicModule.exports;
      } catch (_) { continue; }
      if (!exports) continue;
      stats.initialized++;
      if (typeof exports === "object") {
        for (const key of ["default", "render", "type"]) examineFunction(exports, key, id);
        // Some modules export named components instead of a default.
        try {
          const keys = Object.keys(exports);
          if (keys.length <= 35) for (const key of keys) {
            if (key !== "default" && key !== "render" && key !== "type") examineFunction(exports, key, id);
          }
        } catch (_) {}
      }
    }
    log("Registry " + stats.registry + ", " + stats.initialized + " initialized, " + stats.matches.length + " patches.");
  }

  // V3: Use TouchableOpacity (if exposed by Discord's React Native build)
  // and display direct feedback for every tap. Previously the Scan and Save
  // buttons could appear broken because no status message was rendered.
  function Settings() {
    const [url, setUrl] = React.useState(wallpaperUrl());
    const [opacity, setOpacity] = React.useState(String(overlayOpacity()));
    const [pressCount, setPressCount] = React.useState(0);
    const [scanCount, setScanCount] = React.useState(0);
    const [status, setStatus] = React.useState("No buttons pressed yet.");
    const textStyle = { color: "#e0def4", fontSize: 14, marginTop: 8 };
    const inputStyle = { backgroundColor: "#26233a", borderRadius: 8, padding: 12, marginTop: 8, color: "#e0def4" };
    const Action = RN.TouchableOpacity || RN.Pressable;

    function paragraph(key, content) {
      return React.createElement(RN.Text, { key, selectable: true, style: textStyle }, content);
    }
    function button(key, label, action) {
      return React.createElement(Action, {
        key,
        accessible: true,
        accessibilityRole: "button",
        onPress: function () {
          setPressCount(prev => prev + 1);
          try { action(); }
          catch (e) { setStatus("Button error: " + String(e).slice(0, 140)); }
        },
        style: { padding: 14, backgroundColor: "#c4a7e7", borderRadius: 9, marginTop: 14 }
      }, React.createElement(RN.Text, { style: { color: "#191724", textAlign: "center", fontWeight: "bold" } }, label));
    }
    return React.createElement(RN.ScrollView, {
      style: { flex: 1, backgroundColor: "#191724" },
      contentContainerStyle: { padding: 18, paddingBottom: 80 },
      keyboardShouldPersistTaps: "always"
    },
      React.createElement(RN.Text, { style: { color: "#e0def4", fontSize: 19, fontWeight: "bold" } }, "Rosé Pine Everywhere — V3 diagnostics"),
      paragraph("feedback", "BUTTON FEEDBACK: " + status + " | Taps recorded: " + pressCount),
      button("test", "Test buttons (should count taps)", function () {
        setStatus("The button works. This page received your tap.");
      }),
      paragraph("registry", "Metro registry: " + stats.registry),
      paragraph("stats", "Registry entries: " + stats.total + " | Initialized: " + stats.initialized + " | Named components: " + stats.components),
      paragraph("matches", "Patched screens: " + (stats.matches.join(", ") || "NONE")),
      paragraph("candidates", "Potential screen names (not confirmed): " + (stats.candidates.slice(0, 22).join(", ") || "NONE")),
      paragraph("errors", "Patch errors: " + (stats.errors.slice(0, 4).join("; ") || "none")),
      button("scan", "Rescan loaded screens", function () {
        scan();
        setScanCount(prev => prev + 1);
        setStatus("Scan completed. Found " + stats.matches.length + " patch(es), " + stats.candidates.length + " potential names.");
      }),
      paragraph("scanCount", "Manual rescans: " + scanCount),
      paragraph("instructions", "Open the server/channel list once, then return here and tap Rescan. If patched screens stays NONE, the wallpaper is not being injected."),
      React.createElement(RN.Text, { style: Object.assign({}, textStyle, { marginTop: 24 }) }, "Wallpaper (HTTPS URL)"),
      React.createElement(RN.TextInput, {
        style: inputStyle, value: url, onChangeText: setUrl,
        autoCapitalize: "none", autoCorrect: false, multiline: true,
        placeholderTextColor: "#908caa"
      }),
      paragraph("overlayLabel", "Dark overlay opacity (0.0 to 0.85)"),
      React.createElement(RN.TextInput, {
        style: inputStyle, value: opacity, onChangeText: setOpacity, keyboardType: "decimal-pad"
      }),
      button("save", "Save wallpaper settings", function () {
        if (!/^https:\/\/\S+$/i.test(url.trim())) {
          setStatus("Not saved: enter a complete HTTPS wallpaper URL.");
          return;
        }
        try {
          if (!api || !api.plugin || !api.plugin.storage) {
            setStatus("Not saved: plugin storage is unavailable in this Revenge build.");
            return;
          }
          const n = Number(opacity);
          if (!Number.isFinite(n)) {
            setStatus("Not saved: overlay must be a number from 0 to 0.85.");
            return;
          }
          api.plugin.storage.wallpaperUrl = url.trim();
          api.plugin.storage.overlayOpacity = Math.max(0, Math.min(0.85, n));
          setStatus("Settings saved. Reload Revenge to apply wallpaper changes.");
        } catch (e) {
          setStatus("Could not save: " + String(e).slice(0, 120));
        }
      }),
      paragraph("disclaimer", "This is a diagnostic build. It does not guarantee channel-list wallpaper support; none of the expected screen components have been found on your build.")
    );
  }

  return {
    onLoad: function () {
      try {
        api = vendetta;
        React = api.metro && api.metro.common && api.metro.common.React || globalThis.React;
        RN = api.metro && api.metro.common && api.metro.common.ReactNative;
        if (!React || !RN || !RN.View || !RN.ImageBackground || !api.patcher) {
          stats.registry = "API unavailable (React, ReactNative, or patcher missing)";
          return;
        }
        enabled = true;
        scan();
      } catch (e) {
        enabled = false;
        stats.errors.push(String(e).slice(0, 160));
        log("Initialization failed", e);
      }
    },
    onUnload: function () {
      enabled = false;
      while (unpatches.length) try { unpatches.pop()(); } catch (_) {}
      patchedKeys.clear();
      stats.matches = [];
    },
    settings: Settings
  };
})()
