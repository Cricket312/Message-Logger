(function () {
  "use strict";
  // ==============================================
  // EDIT THESE DEFAULTS TO PERSONALIZE THE PLUGIN
  // ==============================================
  const CONFIG = {
    wallpaperUrl: "https://raw.githubusercontent.com/rose-pine/discord-mobile/main/Assets/V06yN.png",
    overlayOpacity: 0.35, // 0.0 = clear, 1.0 = completely dark
    imageBlur: 0,
    verboseLogging: false
  };
  // ==============================================

  // Candidate screen component names change as Discord updates.
  // Nothing is patched unless an exact match exists in the current build.
  const TARGETS = new Set([
    "GuildChannelList", "GuildChannelListConnected", "GuildChannelListScreen",
    "GuildChannels", "GuildChannelsConnected", "GuildChannelsScreen",
    "ChannelList", "ChannelListConnected", "ChannelDrawer", "ChannelDrawerContent",
    "ChannelsList", "ServerChannelList", "GuildSidebar", "GuildsBar",
    "SettingsScreen", "SettingsOverview", "UserSettingsOverview", "SettingsNavigator"
  ]);

  const activePatches = [];
  const matched = [];
  const errors = [];
  let loaded = false;
  let api = null;
  let React = null;
  let RN = null;

  function log(msg, err) {
    try { console.log('[RosePineEverywhere]', msg, err || ''); } catch (_) {}
  }

  function wallpaperUrl() {
    const s = api && api.plugin && api.plugin.storage;
    const v = s && s.wallpaperUrl;
    return (typeof v === 'string' && /^https:\/\//i.test(v)) ? v : CONFIG.wallpaperUrl;
  }

  function darkOverlay() {
    const s = api && api.plugin && api.plugin.storage;
    const val = s && s.overlayOpacity;
    const n = (val === undefined || val === null || val === '') ? CONFIG.overlayOpacity : Number(val);
    return Math.max(0, Math.min(0.85, Number.isFinite(n) ? n : CONFIG.overlayOpacity));
  }

  function transparencyOnTop(element) {
    // Only make the FIRST returned outer View transparent.  Don't alter
    // individual rows/buttons or force opacity onto arbitrary nested nodes.
    try {
      if (!React.isValidElement(element) || !element.props) return element;
      if (element.props.style == null) return element;
      return React.cloneElement(element, {
        style: [element.props.style, { backgroundColor: 'transparent' }]
      });
    } catch (_) { return element; }
  }

  function withWallpaper(original) {
    if (!loaded || !React || !RN || !original || !React.isValidElement(original)) return original;
    try {
      // The image remains behind the rendered screen and does not handle taps.
      return React.createElement(RN.ImageBackground, {
        source: { uri: wallpaperUrl() },
        style: { flex: 1 },
        imageStyle: { opacity: 1 },
        blurRadius: CONFIG.imageBlur,
        resizeMode: 'cover'
      }, React.createElement(RN.View, {
        style: { flex: 1, backgroundColor: 'rgba(25,23,36,' + darkOverlay() + ')' }
      }, transparencyOnTop(original)));
    } catch (err) {
      if (CONFIG.verboseLogging) log('Failed to render wallpaper', err);
      return original;
    }
  }

  function patchOne(module, key, label) {
    if (!module || typeof module[key] !== 'function' || !api || typeof api.patcher.after !== 'function') return;
    const f = module[key];
    if (f.__rosePineEverywherePatched) return;
    try {
      const undo = api.patcher.after(key, module, function (_args, result) {
        return withWallpaper(result);
      });
      if (typeof undo === 'function') {
        activePatches.push(undo);
        matched.push(label);
        if (CONFIG.verboseLogging) log('Patched ' + label);
      }
    } catch (err) {
      errors.push(label);
      if (CONFIG.verboseLogging) log('Failed to patch ' + label, err);
    }
  }

  function scanLoadedModules(metro) {
    const ids = metro.modules || {};
    // One pass over already-loaded modules only; no forced requires or
    // runtime render interception. This is intentionally fail-safe.
    for (const id in ids) {
      let mod;
      try { mod = ids[id] && ids[id].publicModule && ids[id].publicModule.exports; } catch (_) { continue; }
      if (!mod) continue;
      for (const key of ['default', 'render']) {
        const f = mod[key];
        const name = f && (f.displayName || f.name || (f.type && f.type.name));
        if (name && TARGETS.has(name)) patchOne(mod, key, name);
      }
      if (mod.default && mod.default.type && typeof mod.default.type === 'function') {
        const f = mod.default.type;
        const name = f.displayName || f.name;
        if (name && TARGETS.has(name)) patchOne(mod.default, 'type', name);
      }
    }
  }

  function Settings() {
    // Built with the React Native components Revenge already provides.
    const [url, setUrl] = React.useState(wallpaperUrl());
    const [opacity, setOpacity] = React.useState(String(darkOverlay()));
    const textStyle = { color: '#e0def4', fontSize: 14 };
    const rowStyle = { backgroundColor: '#26233a', padding: 12, marginVertical: 8, borderRadius: 8 };
    const children = [
      React.createElement(RN.Text, { key: 'head', style: { color: '#e0def4', fontSize: 19, fontWeight: 'bold' } }, 'Rosé Pine Everywhere (test)'),
      React.createElement(RN.Text, { key: 'note', style: [textStyle, { marginTop: 12 }] },
        'Experimental: some screens may remain opaque. Matching screens: ' + (matched.join(', ') || 'none found yet.')),
      React.createElement(RN.Text, { key: 'label-url', style: [textStyle, { marginTop: 18 }] }, 'Wallpaper image (HTTPS URL)'),
      React.createElement(RN.TextInput, { key: 'url', style: [rowStyle, textStyle], multiline: true,
        value: url, autoCapitalize: 'none', onChangeText: setUrl, placeholder: 'https://...', placeholderTextColor: '#908caa' }),
      React.createElement(RN.Text, { key: 'label-opacity', style: textStyle }, 'Dark overlay (0.0–0.85)'),
      React.createElement(RN.TextInput, { key: 'opacity', style: [rowStyle, textStyle],
        value: opacity, keyboardType: 'decimal-pad', onChangeText: setOpacity }),
      React.createElement(RN.Pressable, { key: 'save', onPress: function () {
        if (!/^https:\/\//i.test(url)) { log('Wallpaper must use HTTPS'); return; }
        api.plugin.storage.wallpaperUrl = url.trim();
        const n = Number(opacity);
        api.plugin.storage.overlayOpacity = Math.max(0, Math.min(0.85, Number.isFinite(n) ? n : CONFIG.overlayOpacity));
        log('Settings saved. Reload Revenge to apply.');
      }, style: { backgroundColor: '#c4a7e7', padding: 13, borderRadius: 8, marginTop: 10 } },
        React.createElement(RN.Text, { style: { color: '#191724', fontWeight: 'bold', textAlign: 'center' } }, 'Save (then reload Revenge)')),
      React.createElement(RN.Text, { key: 'info', style: [textStyle, { marginTop: 16 }] },
        'Does not request your password or token. Loads the image only from the URL you choose. Disable this plugin if your screens look wrong.')
    ];
    return React.createElement(RN.ScrollView, { style: { flex: 1, backgroundColor: '#191724' }, contentContainerStyle: { padding: 18 } }, ...children);
  }

  return {
    onLoad: function () {
      try {
        api = vendetta;
        React = vendetta.metro && vendetta.metro.common && vendetta.metro.common.React || globalThis.React;
        RN = vendetta.metro && vendetta.metro.common && vendetta.metro.common.ReactNative;
        if (!React || !RN || !RN.ImageBackground || !vendetta.patcher) {
          log('Revenge React Native API not available. No screens were changed.');
          return;
        }
        loaded = true;
        scanLoadedModules(vendetta.metro);
        log('Loaded. Matched ' + matched.length + ' component(s): ' + (matched.join(', ') || 'none.'));
      } catch (err) {
        loaded = false;
        log('Initialization failed (screen remains unchanged).', err);
      }
    },
    onUnload: function () {
      loaded = false;
      while (activePatches.length) {
        try { activePatches.pop()(); } catch (_) {}
      }
      matched.length = 0;
    },
    settings: Settings
  };
})()
