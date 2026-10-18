(() => {
"use strict";
/* Original implementation. All message data stays in this process/storage. */
function createLogEngine(options = {}) {
    const now = options.now || Date.now;
    const defaults = {
        logDeletes: true, logEdits: true, logDMs: true, logServers: true,
        keepDeleted: true, inlineEdits: true, persist: false,
        ignoreBots: false, ignoreSelf: false,
        ignoredUsers: "", ignoredChannels: "", ignoredServers: "",
        maxLogs: 1000, maxCache: 2000, maxVersions: 25, retentionDays: 7,
        maxLogChars: 4000000, maxCacheChars: 4000000
    };
    const settings = Object.assign({}, defaults, options.settings || {});
    const logs = new Map();
    const cache = new Map();
    const listeners = new Set();
    const sizes = new Map();
    const cacheSizes = new Map();
    let logChars = 0, cacheChars = 0, lastPrune = 0;
    const stats = { deletes: 0, edits: 0, missedDeletes: 0 };
    const ownerId = String(options.ownerId || "");
    const key = (channel, id) => String(channel) + ":" + String(id);
    const clean = (v, n = 16000) => typeof v === "string" ? v.slice(0, n) : "";
    const own = (v, k) => Object.prototype.hasOwnProperty.call(v || {}, k);
    const list = v => Array.isArray(v) ? v : v && typeof v.toArray === "function" ? v.toArray() : [];
    const ids = v => new Set(String(v || "").split(/[\s,]+/).filter(Boolean));
    function number(name, minimum, maximum) {
        const x = Number(settings[name]);
        return Math.min(maximum, Math.max(minimum, Number.isFinite(x) ? Math.floor(x) : defaults[name]));
    }
    function stamp(v) {
        if (!v) return "";
        if (typeof v === "string") return clean(v, 80);
        try { return typeof v.toISOString === "function" ? v.toISOString() : ""; } catch (_) { return ""; }
    }
    function attachments(v) {
        return list(v).slice(0, 10).map(a => ({
            id: clean(String(a.id || ""), 32), filename: clean(a.filename || a.name, 256),
            url: clean(a.url, 2048), proxy_url: clean(a.proxy_url || a.proxyURL, 2048),
            size: Number(a.size) || 0, content_type: clean(a.content_type || a.contentType, 100),
            width: Number(a.width) || 0, height: Number(a.height) || 0
        }));
    }
    function snapshot(message, previous) {
        if (!message || !message.id) return null;
        const p = previous || {};
        const channel = String(message.channel_id || message.channelId || p.channel_id || "");
        if (!channel) return null;
        const a = message.author || p.author || {};
        const location = options.resolveChannel ? options.resolveChannel(channel) || {} : {};
        const guild = String(message.guild_id || message.guildId || location.guild_id || p.guild_id || "");
        const flags = Number(message.flags === undefined ? p.flags : message.flags) || 0;
        return {
            id: String(message.id), channel_id: channel, guild_id: guild,
            channelName: clean(location.name || p.channelName, 200),
            guildName: clean(location.guildName || p.guildName, 200),
            parent_id: String(location.parent_id || p.parent_id || ""),
            author: {
                id: String(a.id || ""), username: clean(a.username, 100),
                global_name: clean(a.global_name || a.globalName, 100), bot: !!a.bot
            },
            content: own(message, "content") ? clean(message.content) : clean(p.content),
            contentKnown: own(message, "contentKnown") ? !!message.contentKnown : own(message, "content") ? typeof message.content === "string" : !!p.contentKnown,
            attachments: own(message, "attachments") ? attachments(message.attachments) : attachments(p.attachments),
            attachmentsKnown: own(message, "attachmentsKnown") ? !!message.attachmentsKnown : own(message, "attachments") || !!p.attachmentsKnown,
            timestamp: stamp(message.timestamp) || p.timestamp || "",
            edited_timestamp: stamp(message.edited_timestamp || message.editedTimestamp) || p.edited_timestamp || "",
            type: Number(message.type === undefined ? p.type : message.type) || 0,
            flags
        };
    }
    function tracked(m) {
        if (!m || !ownerId || (m.flags & 64) !== 0) return false;
        if (m.guild_id ? !settings.logServers : !settings.logDMs) return false;
        if (settings.ignoreBots && m.author.bot) return false;
        if (settings.ignoreSelf && m.author.id === ownerId) return false;
        return !ids(settings.ignoredUsers).has(m.author.id)
            && !ids(settings.ignoredChannels).has(m.channel_id)
            && !ids(settings.ignoredChannels).has(m.parent_id)
            && !ids(settings.ignoredServers).has(m.guild_id);
    }
    function announce() {
        if (options.onChange) options.onChange();
        listeners.forEach(fn => { try { fn(); } catch (_) {} });
    }
    function forget(k, notifyEviction = true) {
        const entry = logs.get(k);
        if (!entry) return;
        logs.delete(k); logChars -= sizes.get(k) || 0; sizes.delete(k);
        if (notifyEviction && options.onEvict) options.onEvict(entry);
    }
    function trim(force = false) {
        const time = now();
        if (force || time - lastPrune > 60000) {
            lastPrune = time;
            const oldest = time - number("retentionDays", 1, 365) * 86400000;
            for (const [k, entry] of logs) if (entry.changedAt < oldest) forget(k);
        }
        while (logs.size > number("maxLogs", 50, 5000) || logChars > number("maxLogChars", 100000, 12000000)) {
            forget(logs.keys().next().value);
        }
        while (cache.size > number("maxCache", 50, 10000) || cacheChars > number("maxCacheChars", 100000, 12000000)) {
            const k = cache.keys().next().value;
            cache.delete(k); cacheChars -= cacheSizes.get(k) || 0; cacheSizes.delete(k);
        }
    }
    function remember(message, previous) {
        const m = snapshot(message, previous);
        if (!tracked(m)) return null;
        const k = key(m.channel_id, m.id);
        const size = JSON.stringify(m).length;
        cacheChars -= cacheSizes.get(k) || 0;
        cache.delete(k); cache.set(k, m); cacheSizes.set(k, size); cacheChars += size;
        trim();
        return m;
    }
    function put(entry) {
        const k = key(entry.message.channel_id, entry.message.id);
        logChars -= sizes.get(k) || 0;
        logs.delete(k); logs.set(k, entry);
        const size = JSON.stringify(entry).length;
        sizes.set(k, size); logChars += size;
        trim(); announce();
        return logs.get(k) || null;
    }
    function version(m, observedAt) {
        return { content: m.content, contentKnown: m.contentKnown,
            attachments: attachments(m.attachments), observedAt,
            messageTimestamp: m.edited_timestamp || m.timestamp };
    }
    function sameAttachments(a, b) {
        // Signed CDN URL rotation is not a user edit.
        return JSON.stringify(a.map(x => [x.id, x.filename, x.size])) === JSON.stringify(b.map(x => [x.id, x.filename, x.size]));
    }
    function update(incoming, previous) {
        const channel = incoming && (incoming.channel_id || incoming.channelId);
        if (!incoming || !incoming.id || !channel) return null;
        const k = key(channel, incoming.id);
        const old = cache.get(k) || (previous ? snapshot(previous) : null);
        const current = snapshot(incoming, old);
        if (!tracked(current)) return null;
        remember(current, current);
        const contentChanged = own(incoming, "content") && old && old.contentKnown && current.contentKnown && old.content !== current.content;
        const attachmentChanged = own(incoming, "attachments") && old && old.attachmentsKnown && !sameAttachments(old.attachments, current.attachments);
        if (!settings.logEdits || !old || (!contentChanged && !attachmentChanged)) return null;
        const existing = logs.get(k);
        if (existing && existing.deletedAt) return null;
        const time = now();
        const entry = existing || { message: old, versions: [version(old, time)], editCount: 0, deletedAt: 0, changedAt: time, trimmedVersions: 0 };
        entry.versions.push(version(current, time));
        entry.editCount += 1;
        entry.message = current; entry.changedAt = time;
        const max = number("maxVersions", 2, 100);
        if (entry.versions.length > max) {
            const removed = entry.versions.length - max;
            entry.versions.splice(0, removed); entry.trimmedVersions += removed;
        }
        stats.edits += 1;
        return put(entry);
    }
    function remove(channel, id, previous) {
        const k = key(channel, id);
        const existing = logs.get(k);
        const old = previous ? snapshot(previous, cache.get(k)) : cache.get(k) || (existing && existing.message);
        if (!settings.logDeletes) return null;
        if (!old) { stats.missedDeletes += 1; return null; }
        if (!tracked(old)) return null;
        if (existing && existing.deletedAt) return existing;
        const time = now();
        const entry = existing || { message: old, versions: [version(old, time)], editCount: 0, deletedAt: 0, changedAt: time, trimmedVersions: 0 };
        const latest = entry.versions[entry.versions.length - 1];
        if (!latest || latest.content !== old.content || !sameAttachments(latest.attachments, old.attachments)) {
            entry.versions.push(version(old, time));
            const excess = entry.versions.length - number("maxVersions", 2, 100);
            if (excess > 0) { entry.versions.splice(0, excess); entry.trimmedVersions += excess; }
        }
        entry.message = old; entry.deletedAt = time; entry.changedAt = time;
        stats.deletes += 1;
        return put(entry);
    }
    function clear(channel, id) {
        for (const [k, e] of logs) {
            if ((!channel || e.message.channel_id === String(channel)) && (!id || e.message.id === String(id))) forget(k);
        }
        // Clearing also discards the pre-edit cache in that scope.
        for (const [k, m] of cache) {
            if ((!channel || m.channel_id === String(channel)) && (!id || m.id === String(id))) {
                cache.delete(k); cacheChars -= cacheSizes.get(k) || 0; cacheSizes.delete(k);
            }
        }
        announce();
    }
    function restore(data) {
        if (!data || data.schema !== 1 || data.ownerId !== ownerId || !Array.isArray(data.entries)) return;
        data.entries.slice(-number("maxLogs", 50, 5000)).forEach(e => {
            if (!e || !Array.isArray(e.versions)) return;
            const m = snapshot(e.message);
            if (!m || !tracked(m) || !Number.isFinite(e.changedAt)) return;
            const entry = {
                message: m, versions: e.versions.slice(-number("maxVersions", 2, 100)).map(v => ({
                    content: clean(v.content), contentKnown: v.contentKnown !== false,
                    attachments: attachments(v.attachments), observedAt: Number(v.observedAt) || 0,
                    messageTimestamp: clean(v.messageTimestamp, 80)
                })),
                editCount: Math.max(0, Number(e.editCount) || 0), deletedAt: Number(e.deletedAt) || 0,
                changedAt: e.changedAt, trimmedVersions: Math.max(0, Number(e.trimmedVersions) || 0)
            };
            const k = key(m.channel_id, m.id), size = JSON.stringify(entry).length;
            logChars -= sizes.get(k) || 0; logs.set(k, entry); sizes.set(k, size); logChars += size;
        });
        trim(true);
    }
    const api = {
        settings, stats, ownerId, remember, update, remove, clear, restore, tracked, snapshot,
        get: (channel, id) => logs.get(key(channel, id)),
        getById: id => { for (const e of logs.values()) if (e.message.id === String(id)) return e; },
        entries: () => Array.from(logs.values()).sort((a, b) => b.changedAt - a.changedAt),
        exportData: () => ({ schema: 1, ownerId, entries: Array.from(logs.values()) }),
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
        configure: patch => { Object.assign(settings, patch); trim(true); announce(); },
        counts: () => ({ logs: logs.size, cached: cache.size, logChars, cacheChars })
    };
    return api;
}


/* Decorate only the native presentation. Never change outgoing message text. */
function decorateLoggerRows(packet, engine, processColor) {
    let count = 0;
    const color = processColor || (value => value);
    function row(item) {
        if (!item || !item.message || !item.message.id) return item;
        const message = item.message;
        const channel = message.channelId || message.channel_id;
        const entry = channel ? engine.get(channel, message.id) : engine.getById(message.id);
        if (!entry || !engine.tracked(entry.message)) return item;
        const deleted = !!entry.deletedAt && engine.settings.keepDeleted;
        const edited = entry.editCount > 0 && engine.settings.inlineEdits;
        if (!deleted && !edited) return item;
        const output = Object.assign({}, item, { message: Object.assign({}, message) });
        // Android's message row supports a red background and left gutter.
        if (deleted) {
            output.backgroundHighlight = { backgroundColor: color("#ed424529"), gutterColor: color("#ed4245") };
            output.message.edited = "(deleted · local copy)";
        } else {
            output.message.edited = "(edited · " + entry.editCount + " saved)";
        }
        if (Array.isArray(message.content)) {
            const additions = [];
            if (deleted) additions.push({ type: "text", content: "[Deleted message · local copy]\n" });
            // Keep the latest message intact. Earlier versions follow it.
            const tail = [];
            if (edited) {
                const earlier = entry.versions.slice(0, -1).slice(-3);
                earlier.forEach((v, i) => {
                    const content = v.contentKnown ? (v.content || "[No text]") : "[Text not received]";
                    tail.push({ type: "text", content: "\nEarlier edit " + (i + 1) + ": " });
                    tail.push({ type: "s", content: [{ type: "text", content: content.slice(0, 500) + (content.length > 500 ? "…" : "") }] });
                });
                tail.push({ type: "text", content: "\n[Full history: long-press → Message history, or /mlog]" });
            }
            output.message.content = additions.concat(message.content, tail);
        }
        count += 1;
        return output;
    }
    function visit(value, depth) {
        if (!value || depth > 4) return value;
        if (Array.isArray(value)) {
            const result = value.map(v => v && v.message ? row(v) : visit(v, depth + 1));
            return result.some((x, i) => x !== value[i]) ? result : value;
        }
        if (typeof value === "object") {
            if (value.message) return row(value);
            let output = value;
            for (const name of ["rows", "updates", "items", "data"]) {
                if (!value[name]) continue;
                const result = visit(value[name], depth + 1);
                if (result !== value[name]) {
                    if (output === value) output = Object.assign({}, value);
                    output[name] = result;
                }
            }
            return output;
        }
        return value;
    }
    return { packet: visit(packet, 0), count };
}


function createLoggerUI(api, runtime) {
    const React = api.metro.common.React;
    const RN = api.metro.common.ReactNative;
    const h = React.createElement;
    const colors = { bg: "#16171d", card: "#22242e", text: "#f2f3f5", muted: "#b6b8c4", accent: "#a3acff", danger: "#ff8188", border: "#383b49" };
    const s = RN.StyleSheet.create({
        screen: { flex: 1, backgroundColor: colors.bg },
        body: { padding: 16, paddingBottom: 48 },
        title: { color: colors.text, fontSize: 23, fontWeight: "700", marginBottom: 8 },
        text: { color: colors.text, fontSize: 15, lineHeight: 22 },
        muted: { color: colors.muted, fontSize: 13, lineHeight: 19 },
        card: { backgroundColor: colors.card, padding: 14, borderRadius: 12, marginBottom: 12 },
        button: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 9, borderWidth: 1, borderColor: colors.border, marginTop: 8 },
        buttonText: { color: colors.accent, fontSize: 15, fontWeight: "600" },
        input: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 9, padding: 12, color: colors.text, marginVertical: 9 },
        row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 9 },
        version: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 11, marginTop: 12 },
        deleted: { borderLeftWidth: 3, borderLeftColor: colors.danger },
        chips: { flexDirection: "row", flexWrap: "wrap", marginBottom: 12 },
        chip: { paddingVertical: 9, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 20, marginRight: 6, marginTop: 6 }
    });
    function text(value, style, props) { return h(RN.Text, Object.assign({ style: [s.text, style] }, props), value); }
    function button(label, onPress, danger = false) {
        return h(RN.TouchableOpacity, { style: s.button, onPress, accessibilityRole: "button" },
            text(label, [s.buttonText, danger && { color: colors.danger }]));
    }
    function time(value) { try { return value ? new Date(value).toLocaleString() : "Time unavailable"; } catch (_) { return "Time unavailable"; } }
    function location(m) { return m.guild_id ? (m.guildName || "Server " + m.guild_id) + " / #" + (m.channelName || m.channel_id) : (m.channelName || "Direct message"); }
    function author(m) { return m.author.global_name || m.author.username || m.author.id || "Unknown author"; }
    function useRefresh() {
        const [, update] = React.useState(0);
        React.useEffect(() => runtime.subscribe(() => update(v => v + 1)), []);
        return () => update(v => v + 1);
    }
    function confirmClear(channel, id) {
        RN.Alert.alert("Clear local history?", "This removes the selected saved copies from this plugin. It does not delete messages on Discord.", [
            { text: "Cancel", style: "cancel" },
            { text: "Clear", style: "destructive", onPress: () => runtime.clear(channel, id) }
        ]);
    }
    function detail(entry) {
        const m = entry.message;
        return h(RN.View, { key: m.id, style: [s.card, entry.deletedAt && s.deleted] },
            text(author(m), { fontWeight: "700", fontSize: 17 }),
            text(location(m), s.muted),
            text(entry.deletedAt ? "Deleted · " + time(entry.deletedAt) : "Edited · " + time(entry.changedAt), { color: entry.deletedAt ? colors.danger : colors.accent, marginTop: 5 }),
            entry.trimmedVersions ? text(entry.trimmedVersions + " older versions removed by the storage limit.", s.muted) : null,
            entry.versions.map((v, i) => h(RN.View, { key: String(i), style: s.version },
                text((i === entry.versions.length - 1 ? "Latest captured version" : "Earlier version " + (i + 1)) + " · " + time(v.messageTimestamp || v.observedAt), s.muted),
                text(v.contentKnown ? (v.content || "[No text]") : "[Text was not received]", { marginTop: 6 }, { selectable: true }),
                v.attachments.map((a, j) => text("Attachment: " + (a.filename || a.id) + (a.url ? "\n" + a.url : ""), [s.muted, { marginTop: 8 }], { key: String(j), selectable: true }))
            )),
            text("Message ID: " + m.id, [s.muted, { marginTop: 10 }], { selectable: true }),
            button("Clear this message’s local history", () => confirmClear(m.channel_id, m.id), true)
        );
    }
    function History(props = {}) {
        useRefresh();
        const [query, setQuery] = React.useState("");
        const [kind, setKind] = React.useState("all");
        const [selected, setSelected] = React.useState(props.messageId || "");
        const [page, setPage] = React.useState(40);
        const engine = runtime.engine();
        const all = engine ? engine.entries() : [];
        const q = query.trim().toLowerCase();
        const entries = all.filter(e => {
            if (props.channelId && e.message.channel_id !== props.channelId) return false;
            if (kind === "deleted" && !e.deletedAt) return false;
            if (kind === "edited" && !e.editCount) return false;
            if (kind === "dms" && e.message.guild_id) return false;
            if (kind === "servers" && !e.message.guild_id) return false;
            return !q || [author(e.message), location(e.message), e.message.id, e.message.channel_id, ...e.versions.map(v => v.content)].join("\n").toLowerCase().includes(q);
        });
        const chosen = selected && all.find(e => e.message.id === selected && (!props.channelId || e.message.channel_id === props.channelId));
        return h(RN.ScrollView, { style: s.screen, contentContainerStyle: s.body, keyboardShouldPersistTaps: "handled" },
            text("Message history", s.title),
            text("Only messages received by this client can be captured. Attachment files are not downloaded.", s.muted),
            props.onBack ? button("Back", props.onBack) : null,
            selected ? button("Show message list", () => setSelected("")) : null,
            chosen ? detail(chosen) : h(React.Fragment, null,
                h(RN.TextInput, { style: s.input, placeholder: "Search text, author, channel, or ID", placeholderTextColor: colors.muted, value: query, onChangeText: v => { setQuery(v); setPage(40); }, autoCapitalize: "none", accessibilityLabel: "Search saved messages" }),
                h(RN.View, { style: s.chips }, [ ["all", "All"], ["deleted", "Deleted"], ["edited", "Edited"], ["dms", "DMs"], ["servers", "Servers"] ].map(([value, label]) =>
                    h(RN.TouchableOpacity, { key: value, style: [s.chip, kind === value && { backgroundColor: "#333a6b" }], onPress: () => { setKind(value); setPage(40); }, accessibilityRole: "button" }, text(label, { fontSize: 13 })))),
                text(entries.length + " logged messages", [s.muted, { marginBottom: 12 }]),
                entries.length ? entries.slice(0, page).map(e => h(RN.TouchableOpacity, {
                    key: e.message.channel_id + ":" + e.message.id, style: [s.card, e.deletedAt && s.deleted],
                    onPress: () => setSelected(e.message.id), accessibilityRole: "button"
                }, text(author(e.message), { fontWeight: "700" }), text(location(e.message), s.muted),
                text((e.deletedAt ? "Deleted" : "Edited") + (e.editCount ? " · " + e.editCount + " edit(s)" : ""), { color: e.deletedAt ? colors.danger : colors.accent, fontSize: 13 }),
                text(e.message.content || "[No text]", { marginTop: 6 }, { numberOfLines: 3 }),
                text(time(e.changedAt), [s.muted, { marginTop: 6 }]))) : text("No captured messages here yet. Edit or delete a message while Revenge is connected to try it.", s.muted),
                entries.length > page ? button("Show more", () => setPage(page + 40)) : null,
                entries.length ? button(props.channelId ? "Clear this channel’s local log" : "Clear all local logs", () => confirmClear(props.channelId), true) : null
            )
        );
    }
    function Settings() {
        useRefresh();
        const [showLog, setShowLog] = React.useState(false);
        const engine = runtime.engine();
        const prefs = runtime.preferences();
        if (showLog) return h(History, { onBack: () => setShowLog(false) });
        function toggle(name, label, subtitle) {
            return h(RN.View, { key: name, style: s.row }, h(RN.View, { style: { flex: 1, paddingRight: 12 } }, text(label), subtitle ? text(subtitle, s.muted) : null),
                h(RN.Switch, { value: !!prefs[name], onValueChange: value => runtime.configure({ [name]: value }), accessibilityLabel: label }));
        }
        function field(name, label, numeric = false) {
            return h(RN.View, { key: name }, text(label, s.muted), h(RN.TextInput, {
                style: s.input, defaultValue: String(prefs[name]), key: name,
                placeholderTextColor: colors.muted, autoCapitalize: "none", keyboardType: numeric ? "number-pad" : "default",
                onEndEditing: e => runtime.configure({ [name]: numeric ? Number(e.nativeEvent.text) : e.nativeEvent.text }), accessibilityLabel: label
            }));
        }
        return h(RN.ScrollView, { style: s.screen, contentContainerStyle: s.body, keyboardShouldPersistTaps: "handled" },
            text("Local Message Logger", s.title),
            text("Classic beta · Vencord-inspired chat highlights and edit history", s.muted),
            button("Open message history (" + (engine ? engine.counts().logs : 0) + ")", () => setShowLog(true)),
            h(RN.View, { style: [s.card, { marginTop: 14 }] }, text(runtime.status(), s.muted)),
            h(RN.View, { style: s.card },
                toggle("logDeletes", "Log deleted messages"), toggle("logEdits", "Log edited messages"),
                toggle("logDMs", "Capture DMs and group DMs"), toggle("logServers", "Capture servers and threads"),
                toggle("keepDeleted", "Keep deleted messages in chat", "While the message remains in the client’s loaded history."),
                toggle("inlineEdits", "Show earlier edits in chat", "Up to 3 earlier text snippets; open history for full versions."),
                toggle("persist", "Save history across restarts", "Off by default, like Vencord. Saved text is not encrypted by this plugin."),
                toggle("ignoreBots", "Ignore bots"), toggle("ignoreSelf", "Ignore my messages")
            ),
            h(RN.View, { style: s.card },
                text("Limits and exclusions", { fontWeight: "700", marginBottom: 10 }),
                field("maxLogs", "Maximum logged messages (50–5000)", true), field("retentionDays", "Keep history for days (1–365)", true),
                field("ignoredUsers", "Ignored user IDs, separated by commas"),
                field("ignoredChannels", "Ignored channel or category IDs, separated by commas"),
                field("ignoredServers", "Ignored server IDs, separated by commas"),
                text("Exclusions apply to new capture. Clear saved logs to remove older entries. A size cap also removes the oldest entries.", s.muted)
            ),
            text("Logging needs Revenge running and receiving events. It cannot recover earlier deletions, missed offline edits, or inaccessible channels. Discord attachment links can expire.", s.muted),
            button("Clear all local history", () => confirmClear(), true)
        );
    }
    return { Settings, History, button };
}


function createClassicPlugin(api) {
    const common = api.metro.common;
    const RN = common.ReactNative;
    const React = common.React;
    const storage = api.plugin.storage;
    const disposers = [];
    const timers = new Set();
    const subscribers = new Set();
    const retained = new Map();
    let engine, ui, dispatcher, messageStore, channelStore, guildStore, userStore;
    let active = false, saving, nativeHook = false, painted = 0, menuHook = false, recordHook = false;
    let lastError = "", lastOwner = "", awaitingLogin = false;
    const basePrefs = createLogEngine().settings;
    let prefs = Object.assign({}, basePrefs);
    try {
        const stored = JSON.parse(storage.preferencesJSON || "{}");
        Object.keys(basePrefs).forEach(k => { if (Object.prototype.hasOwnProperty.call(stored, k)) prefs[k] = stored[k]; });
    } catch (_) {}
    function notify() { subscribers.forEach(fn => { try { fn(); } catch (_) {} }); }
    function safeFind(name, ...args) { try { return api.metro[name](...args); } catch (_) { return undefined; } }
    function getStore(name, props) { return safeFind("findByStoreName", name) || safeFind("findByProps", ...props); }
    function task(fn) {
        const timer = setTimeout(() => { timers.delete(timer); if (active) fn(); }, 0);
        timers.add(timer);
    }
    function error(context, err) {
        lastError = context + ": " + (err && err.message ? err.message : String(err));
        if (api.logger && api.logger.warn) api.logger.warn("Local Message Logger: " + lastError);
    }
    function currentId() { try { return String(userStore.getCurrentUser()?.id || ""); } catch (_) { return ""; } }
    function getMessage(channel, id) { try { return messageStore.getMessage(channel, id); } catch (_) { return undefined; } }
    function flush() {
        if (saving) { clearTimeout(saving); saving = undefined; }
        try {
            if (prefs.persist && engine && engine.ownerId) storage.archiveJSON = JSON.stringify(engine.exportData());
            else if (!prefs.persist) storage.archiveJSON = "";
        } catch (err) { error("Could not save local history", err); }
    }
    function changed() {
        notify();
        if (prefs.persist && !saving) saving = setTimeout(flush, 300);
    }
    function internal(event) {
        dispatcher.dispatch(Object.assign({}, event, { __localMessageLogger: true }));
    }
    function refresh(entry) {
        const m = entry.message;
        const current = getMessage(m.channel_id, m.id);
        if (!current) return;
        // A partial update, not a new message: no sends, pings, or unread increments.
        internal({ type: "MESSAGE_UPDATE", message: {
            id: m.id, channel_id: m.channel_id, content: current.content,
            __localMessageLoggerRefresh: true
        } });
    }
    function evicted(entry) {
        const m = entry.message, key = m.channel_id + ":" + m.id;
        const wasRetained = retained.has(key);
        task(() => {
            if (wasRetained) { retained.delete(key); internal({ type: "MESSAGE_DELETE", channelId: m.channel_id, id: m.id }); }
            else refresh(entry);
        });
    }
    function setupAccount(id) {
        if (engine && lastOwner === id) return;
        if (engine) flush();
        retained.clear(); lastOwner = id;
        engine = createLogEngine({
            ownerId: id, settings: prefs, onChange: changed, onEvict: evicted,
            resolveChannel(channel) {
                try {
                    const c = channelStore?.getChannel(channel);
                    const g = c?.guild_id && guildStore?.getGuild(c.guild_id);
                    return c ? { name: c.name, guild_id: c.guild_id, parent_id: c.parent_id, guildName: g?.name } : {};
                } catch (_) { return {}; }
            }
        });
        if (prefs.persist && id) {
            try { engine.restore(JSON.parse(storage.archiveJSON || "null")); } catch (_) {}
        }
        notify();
    }
    function configure(patch) {
        const oldKeep = prefs.keepDeleted;
        Object.keys(patch).forEach(k => {
            if (!Object.prototype.hasOwnProperty.call(basePrefs, k)) return;
            let v = patch[k];
            if (typeof basePrefs[k] === "boolean") v = !!v;
            if (typeof basePrefs[k] === "string") v = String(v).slice(0, 10000);
            if (typeof basePrefs[k] === "number") v = Number.isFinite(Number(v)) ? Number(v) : basePrefs[k];
            if (k === "maxLogs") v = Math.max(50, Math.min(5000, Math.round(v)));
            if (k === "retentionDays") v = Math.max(1, Math.min(365, Math.round(v)));
            prefs[k] = v;
        });
        storage.preferencesJSON = JSON.stringify(prefs);
        engine.configure(prefs);
        if (oldKeep && !prefs.keepDeleted) {
            for (const e of Array.from(retained.values())) evicted(e);
        } else {
            for (const e of Array.from(retained.values())) if (!engine.tracked(e.message)) evicted(e);
        }
        for (const entry of engine.entries()) if (!entry.deletedAt) task(() => refresh(entry));
        flush(); notify();
    }
    function openHistory(channelId, messageId) {
        try {
            common.navigation.push("BUNNY_CUSTOM_PAGE", {
                title: "Message history",
                render: () => React.createElement(ui.History, { channelId, messageId })
            });
        } catch (err) {
            error("Could not open history page", err);
            RN.Alert.alert("Message history", "Open Revenge → Plugins → Local Message Logger → Settings → Open message history.");
        }
    }
    function handle(event) {
        if (!event || event.__localMessageLogger) return event;
        if (event.type === "LOGOUT") { flush(); awaitingLogin = true; setupAccount(""); return event; }
        if (event.type === "CONNECTION_OPEN" && event.user?.id) {
            awaitingLogin = false; setupAccount(String(event.user.id));
        } else if (!awaitingLogin) {
            const id = currentId();
            if (id !== lastOwner) setupAccount(id);
        }
        if (!engine?.ownerId) return event;
        if (event.type === "MESSAGE_CREATE") {
            if (!event.optimistic) engine.remember(event.message);
        } else if (event.type === "LOAD_MESSAGES_SUCCESS") {
            for (const message of event.messages || []) engine.remember(message);
        } else if (event.type === "MESSAGE_UPDATE") {
            const incoming = event.message;
            if (!incoming?.id) return event;
            const channel = incoming.channel_id || incoming.channelId || event.channelId;
            if (channel) engine.update(Object.assign({}, incoming, { channel_id: channel }), getMessage(channel, incoming.id));
        } else if (event.type === "MESSAGE_DELETE" || event.type === "MESSAGE_DELETE_BULK") {
            const channel = event.channelId || event.channel_id;
            if (!channel) return event;
            const bulk = event.type === "MESSAGE_DELETE_BULK";
            const ids = bulk ? event.ids || [] : [event.id];
            const kept = [];
            for (const id of ids) {
                if (!id) continue;
                const original = getMessage(channel, id);
                const entry = engine.remove(channel, id, original);
                // Do not invent/re-create unseen messages. Keep only loaded records.
                if (entry && prefs.keepDeleted && original && nativeHook && recordHook) {
                    retained.set(channel + ":" + id, entry);
                    kept.push(String(id));
                    if (bulk) task(() => refresh(entry));
                }
            }
            if (!kept.length) return event;
            if (bulk) return Object.assign({}, event, { ids: ids.filter(id => !kept.includes(String(id))) });
            const entry = engine.get(channel, event.id);
            return {
                type: "MESSAGE_UPDATE", channelId: channel, __localMessageLogger: true,
                message: { id: String(event.id), channel_id: String(channel), content: entry.message.content, __localMessageLoggerRefresh: true }
            };
        }
        return event;
    }
    function installRecordHook() {
        const records = safeFind("findByProps", "updateMessageRecord", "createMessageRecord");
        if (!records || typeof records.updateMessageRecord !== "function") return;
        disposers.push(api.patcher.after("updateMessageRecord", records, ([old, incoming], result) => {
            if (!incoming?.__localMessageLoggerRefresh || !result || typeof result !== "object") return result;
            // Keep MessageRecord's prototype (and its methods), while invalidating render memoization.
            return Object.assign(Object.create(Object.getPrototypeOf(result)), result);
        }));
        recordHook = true;
    }
    function installNativeHook() {
        let nativeModules;
        try { nativeModules = RN.NativeModules || {}; } catch (_) { nativeModules = {}; }
        const candidates = [nativeModules.DCDChatManager, nativeModules.NativeChatModule, safeFind("findByProps", "updateRows")];
        // Some Classic builds expose TurboModules only through nativeModuleProxy.
        try {
            if (typeof nativeModuleProxy !== "undefined") candidates.push(nativeModuleProxy.DCDChatManager, nativeModuleProxy.NativeChatModule);
        } catch (_) {}
        const unique = new Set();
        for (const module of candidates) {
            if (!module || unique.has(module) || typeof module.updateRows !== "function") continue;
            unique.add(module);
            try {
                disposers.push(api.patcher.before("updateRows", module, args => {
                    if (!active || !engine || !engine.counts().logs) return;
                    try {
                        for (let i = 0; i < args.length; i++) {
                            let value = args[i], isJSON = false;
                            if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) {
                                try { value = JSON.parse(value); isJSON = true; } catch (_) { continue; }
                            }
                            if (!value || typeof value !== "object") continue;
                            const result = decorateLoggerRows(value, engine, RN.processColor);
                            if (result.count) { args[i] = isJSON ? JSON.stringify(result.packet) : result.packet; painted += result.count; }
                        }
                    } catch (err) { error("Native row decoration unavailable", err); }
                }));
                nativeHook = true;
            } catch (_) {}
        }
    }
    function installMenuHook() {
        const sheets = safeFind("findByProps", "openLazy", "hideActionSheet");
        if (!sheets || typeof sheets.openLazy !== "function") return;
        disposers.push(api.patcher.before("openLazy", sheets, args => {
            const [component, key, props] = args;
            const m = props?.message;
            if (!active || key !== "MessageLongPressActionSheet" || !m || !engine.get(m.channel_id, m.id) || !component?.then) return;
            args[0] = component.then(mod => {
                if (!active || typeof mod?.default !== "function") return mod;
                const original = mod.default;
                function LoggerMessageActions(p) {
                    const result = original(p);
                    if (!active || !engine.get(m.channel_id, m.id)) return result;
                    let added = false;
                    const action = ui.button("Message history · local", () => {
                        sheets.hideActionSheet();
                        openHistory(m.channel_id, m.id);
                    });
                    function inject(node, depth) {
                        if (!node || depth > 12 || added) return node;
                        if (Array.isArray(node)) {
                            if (node.some(child => child?.type?.name === "ButtonRow" || child?.type?.displayName === "ButtonRow")) {
                                added = true;
                                return node.concat(React.cloneElement(action, { key: "local-message-history" }));
                            }
                            return node.map(child => inject(child, depth + 1));
                        }
                        if (React.isValidElement(node) && node.props?.children) {
                            return React.cloneElement(node, {}, inject(node.props.children, depth + 1));
                        }
                        return node;
                    }
                    return inject(result, 0);
                }
                return Object.assign({}, mod, { default: LoggerMessageActions });
            });
        }));
        menuHook = true;
    }
    const runtime = {
        engine: () => engine, preferences: () => prefs,
        subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn); },
        configure, openHistory,
        clear(channel, id) { engine.clear(channel, id); flush(); },
        status() {
            return "Capture: " + (active && engine?.ownerId ? "running" : "waiting for login")
                + ". Chat styling: " + (nativeHook ? (painted ? "active" : "hook found; waiting for a logged message") : "unavailable on this build; use the history page")
                + ". Message refresh: " + (recordHook ? "hook found" : "limited")
                + ". Long-press menu: " + (menuHook ? "hook found (layout dependent)" : "use /mlog or settings")
                + (lastError ? ". Last issue: " + lastError : ".");
        }
    };
    function onLoad() {
        if (active) return;
        dispatcher = common.FluxDispatcher || safeFind("findByProps", "dispatch", "subscribe");
        messageStore = getStore("MessageStore", ["getMessage", "getMessages"]);
        channelStore = getStore("ChannelStore", ["getChannel", "getDMFromUserId"]);
        guildStore = getStore("GuildStore", ["getGuild", "getGuilds"]);
        userStore = getStore("UserStore", ["getCurrentUser"]);
        if (!dispatcher?.dispatch || !messageStore?.getMessage || !userStore?.getCurrentUser) throw new Error("Required Discord stores were not found on this Classic build.");
        active = true;
        setupAccount(currentId());
        ui = createLoggerUI(api, runtime);
        installRecordHook();
        disposers.push(api.patcher.instead("dispatch", dispatcher, (args, original) => {
            let event = args[0];
            if (active) { try { event = handle(event); } catch (err) { error("Capture failed; allowing Discord event", err); } }
            return original.apply(dispatcher, [event].concat(args.slice(1)));
        }));
        installNativeHook();
        try { installMenuHook(); } catch (err) { error("Long-press history unavailable", err); }
        if (api.commands?.registerCommand) {
            try {
                disposers.push(api.commands.registerCommand({
                    name: "mlog", description: "Open this channel’s local message history", options: [],
                    execute(_args, context) {
                        openHistory(context?.channel?.id);
                        // No return object: Classic would SEND a returned content object.
                    }
                }));
            } catch (err) { error("Local history command unavailable", err); }
        }
        if (RN.AppState?.addEventListener) {
            const subscription = RN.AppState.addEventListener("change", state => { if (state !== "active") flush(); });
            disposers.push(() => subscription?.remove?.());
        }
        if (!prefs.persist) storage.archiveJSON = "";
    }
    function onUnload() {
        if (!active) return;
        flush();
        active = false;
        timers.forEach(clearTimeout); timers.clear();
        for (const entry of engine.entries()) if (!entry.deletedAt) { try { refresh(entry); } catch (_) {} }
        // Undo patches before the local removals so they cannot be logged again.
        for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch (_) {} }
        for (const entry of retained.values()) {
            try { internal({ type: "MESSAGE_DELETE", channelId: entry.message.channel_id, id: entry.message.id }); } catch (_) {}
        }
        retained.clear();
        notify();
    }
    return {
        onLoad, onUnload,
        settings: function LoggerSettings() { return ui ? React.createElement(ui.Settings) : React.createElement(RN.Text, null, "Enable this plugin to open its settings."); }
    };
}


return createClassicPlugin(vendetta);
})()
