(() => {
    const VERSION = '1.1.3';
    const CACHE_NAME = 'iptv-img-v1';
    const MAX_ENTRIES = 800;
    const BATCH = 150;
    const DIRECT_CONCURRENCY = 10;

    const config = {
        useProxy: false,
        proxyPath: '/user-agent-proxy.php',
        // домены, которые всегда апгрейдим с http -> https
        httpsDomains: [/^cdn\.epg\.one$/i, /^epg\.one$/i],
        // явная замена хоста + протокола (если совпал — жёстко переводим на https://<target>)
        domainUpgrade: {
            'epg.one': 'cdn.epg.one'
        },
        observeDOM: true,
        swPrefetch: true
    };

    const state = { installed: false, memoryCache: new Map(), observer: null };
    const capabilities = { cacheApi: false };

    const hasSW = () => 'serviceWorker' in navigator;
    const hasCacheAPI = () => 'caches' in window;

    async function detectCaps() {
        if (!hasCacheAPI()) { capabilities.cacheApi = false; return; }
        try { const c = await caches.open(CACHE_NAME); capabilities.cacheApi = !!c; }
        catch { capabilities.cacheApi = false; }
    }

    // ---------- URL нормализация ----------
    function normalizeLogoUrl(url) {
        if (!url) return null;
        let s = String(url).trim().replace(/^['"]|['"]$/g, ''); // убрать кавычки

        // //host/path — всегда https
        if (s.startsWith('//')) s = 'https:' + s;

        // data: / https: — уже ок
        if (/^(data:|https:)/i.test(s)) return s;

        // http:
        if (/^http:/i.test(s)) {
            try {
                const u = new URL(s);

                // 1) Явная замена домена (epg.one → cdn.epg.one) + https
                const target = config.domainUpgrade?.[u.hostname.toLowerCase()];
                if (target) {
                    u.hostname = target;
                    u.protocol = 'https:';
                    return u.toString();
                }

                // 2) Если домен в httpsDomains — тоже апгрейд до https
                if (config.httpsDomains?.some(re => re.test(u.hostname))) {
                    u.protocol = 'https:';
                    return u.toString();
                }

                // 3) Иначе, если разрешён прокси — гоняем через него
                if (config.useProxy && config.proxyPath) {
                    const proxy = new URL(config.proxyPath, location.href);
                    proxy.searchParams.set('url', s);
                    return proxy.toString();
                }
            } catch { /* fallthrough */ }
        }

        // относительные / странные — пробуем как относительный к origin
        try { return new URL(s, location.origin).toString(); }
        catch { return s; }
    }

    // ---------- SW prefetch ----------
    async function swPrefetch(urls) {
        if (!hasSW()) return false;
        try {
            const reg = await navigator.serviceWorker.ready;
            if (!reg.active) return false;
            for (let i = 0; i < urls.length; i += BATCH) {
                reg.active.postMessage({ type: 'PREFETCH_ICONS', urls: urls.slice(i, i + BATCH) });
            }
            return true;
        } catch { return false; }
    }

    // ---------- Прямое кэширование с ограничением конкурентности ----------
    async function directPrefetch(urls) {
        const putOne = async (url, cache) => {
            try {
                const res = await fetch(url, { mode: 'no-cors', cache: 'force-cache' });
                if (cache) {
                    try { await cache.put(url, res.clone()); } catch {}
                } else {
                    if (res.ok || res.type === 'opaque') state.memoryCache.set(url, Date.now());
                }
            } catch {}
        };

        const cache = capabilities.cacheApi ? await caches.open(CACHE_NAME).catch(() => null) : null;

        for (let i = 0; i < urls.length; i += DIRECT_CONCURRENCY) {
            await Promise.allSettled(urls.slice(i, i + DIRECT_CONCURRENCY).map(u => putOne(u, cache)));
        }

        // Усечка
        if (cache) {
            try {
                const keys = await cache.keys();
                if (keys.length > MAX_ENTRIES) {
                    const toDelete = keys.slice(0, keys.length - MAX_ENTRIES);
                    await Promise.allSettled(toDelete.map(k => cache.delete(k)));
                }
            } catch {}
        } else {
            if (state.memoryCache.size > MAX_ENTRIES) {
                const keys = [...state.memoryCache.keys()];
                keys.slice(0, keys.length - MAX_ENTRIES).forEach(k => state.memoryCache.delete(k));
            }
        }
    }

    // ---------- Основной префетч ----------
    async function prefetchIcons(rawUrls) {
        if (!Array.isArray(rawUrls)) return;
        const urls = [...new Set(rawUrls.map(normalizeLogoUrl).filter(Boolean))];
        if (!urls.length) return;
        if (config.swPrefetch && await swPrefetch(urls)) return;
        await directPrefetch(urls);
    }

    // ---------- Сборщики ----------
    const collectFromEpgXML = (xmlText) => {
        try {
            const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
            return [...doc.querySelectorAll('channel > icon')]
                .map(el => el.getAttribute('src')?.trim() || el.textContent?.trim())
                .filter(Boolean);
        } catch { return []; }
    };

    const collectFromEpgDoc = (doc) => {
        try {
            return [...doc.querySelectorAll('channel > icon')]
                .map(el => el.getAttribute('src')?.trim() || el.textContent?.trim())
                .filter(Boolean);
        } catch { return []; }
    };

    const collectFromEpgCache = (epgCache) => {
        try {
            return Object.values(epgCache || {})
                .map(item => item?.icon?.trim())
                .filter(Boolean);
        } catch { return []; }
    };

    // ---------- DOM Observer ----------
    function installObserver() {
        if (!config.observeDOM || state.observer) return;

        const rewrite = (img) => {
            if (!img?.getAttribute || img.dataset.__ec_done) return;
            const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original');
            if (!raw) return;

            const safe = normalizeLogoUrl(raw);
            if (!safe) return;

            if (img.getAttribute('src') !== safe) img.setAttribute('src', safe);
            img.loading = 'lazy';
            img.decoding = 'async';
            img.dataset.__ec_done = '1';
        };

        document.querySelectorAll('img.channel-logo').forEach(rewrite);

        const observer = new MutationObserver(mutations => {
            for (const m of mutations) {
                if (m.type === 'childList') {
                    for (const node of m.addedNodes) {
                        if (!(node instanceof Element)) continue;
                        if (node.matches?.('img.channel-logo')) rewrite(node);
                        node.querySelectorAll?.('img.channel-logo').forEach(rewrite);
                    }
                } else if (m.type === 'attributes' && m.target?.matches?.('img.channel-logo')) {
                    rewrite(m.target);
                }
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'data-src', 'data-original']
        });

        state.observer = observer;
    }

    // ---------- Интеграция с приложением ----------
    function attachToApp() {
        const app = window.iptvApp;
        if (!app?.components?.epgManager) return;
        try {
            const em = app.components.epgManager;
            if (app.subscribe) {
                app.subscribe(em, 'loaded', async (epgCache) => {
                    const urls = collectFromEpgCache(epgCache);
                    if (urls.length) await prefetchIcons(urls);
                });
            }
            const existing = app.components.appState?.get('epgData');
            if (existing) {
                const urls = collectFromEpgCache(existing);
                if (urls.length) prefetchIcons(urls);
            }
        } catch {}
    }

    function waitForApp(tries = 60) {
        if (window.iptvApp?.components?.epgManager) { attachToApp(); return; }
        if (tries > 0) setTimeout(() => waitForApp(tries - 1), 500);
    }

    // ---------- Публичный API ----------
    const API = {
        init(options = {}) {
            if (state.installed) return API;
            Object.assign(config, options);
            state.installed = true;
            detectCaps().finally(() => { installObserver(); waitForApp(); });
            return API;
        },
        version: () => VERSION,
        info: () => ({ VERSION, CACHE_NAME, MAX_ENTRIES, BATCH, DIRECT_CONCURRENCY, capabilities: { ...capabilities }, config: { httpsDomains: config.httpsDomains?.map(r=>r.toString()), domainUpgrade: { ...config.domainUpgrade } } }),
        normalizeLogoUrl, prefetchIcons, collectFromEpgXML, collectFromEpgDoc, collectFromEpgCache,
        pickLogoSrc({ playlistIcon, epgIcon, fallback = '/css/no_logo.png' } = {}) {
            return normalizeLogoUrl(playlistIcon || epgIcon) || fallback;
        },
        async clearCache() {
            state.memoryCache.clear();
            if (capabilities.cacheApi) { try { await caches.delete(CACHE_NAME); } catch {} }
        },
        async size() {
            if (capabilities.cacheApi) { try { const k = await (await caches.open(CACHE_NAME)).keys(); return k.length; } catch { return 0; } }
            return state.memoryCache.size;
        }
    };

    window.EPGIconCache = API;

    const boot = () => { if (!state.installed) API.init(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();