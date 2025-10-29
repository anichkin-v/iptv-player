/*!
 * ua_settings.js — User-Agent настройки + UA-прокси (fetch/XHR hook)
 * Экспортирует: window.UASettings
 *
 * Подключайте ПЕРЕД favorit.js
 */
(function(){
    'use strict';

    // ---------- i18n ----------
    function tr(k, fb){
        try {
            if (typeof window.t === 'function') return window.t(k, fb);
            if (window.I18N_AJAX?.t) return window.I18N_AJAX.t(k, fb);
        } catch(_) {}
        return fb ?? k;
    }

    // ---------- Storage keys ----------
    const LS = {
        uaEnable: 'app:uaEnable',
        uaMode:   'app:uaMode',     // 'preset' | 'manual'
        uaPreset: 'app:uaPreset',   // wink|ios|...
        uaManual: 'app:uaManual'
    };

    // ---------- UA presets (синхронизированы с PHP) ----------
    const UA_PRESETS = {
        wink:    'Mozilla/5.0 (Linux; Android 9; Wink) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Mobile Safari/537.36',
        android: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
        smarttv: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1'
    };

    // ---------- Config ----------
    const UA_PROXY_PATH = window.UA_PROXY_PATH || '/user-agent-proxy.php';

    // ---------- utils ----------
    const readJSON  = (k, d)=>{ try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
    const writeJSON = (k, v)=> localStorage.setItem(k, JSON.stringify(v));
    const $  = (sel, root=document) => root.querySelector(sel);
    const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

    function isEnabled(){ return !!readJSON(LS.uaEnable, false); }
    function getMode(){ return localStorage.getItem(LS.uaMode) || 'preset'; }
    function getPresetKey(){ return localStorage.getItem(LS.uaPreset) || 'wink'; }
    function getManual(){ return localStorage.getItem(LS.uaManual) || ''; }
    function getUAString(){
        const mode = getMode();
        if (mode === 'manual') return getManual() || UA_PRESETS.wink;
        const key = getPresetKey();
        return UA_PRESETS[key] || UA_PRESETS.wink;
    }

    function setState({ enabled, mode, preset, manual }){
        if (typeof enabled === 'boolean') writeJSON(LS.uaEnable, enabled);
        if (mode) localStorage.setItem(LS.uaMode, mode);
        if (mode === 'preset' && preset) localStorage.setItem(LS.uaPreset, preset);
        if (mode === 'manual' && typeof manual === 'string') localStorage.setItem(LS.uaManual, manual);

        window.dispatchEvent(new CustomEvent('settings:userAgentChanged', {
            detail: { mode: getMode(), preset: getPresetKey(), ua: getUAString() }
        }));
        window.dispatchEvent(new CustomEvent('settings:userAgentProxyToggled', {
            detail: { enabled: isEnabled() }
        }));
    }

    // ---------- Proxy URL ----------
    function buildProxyUrl(origUrl){
        try{
            const u = new URL(UA_PROXY_PATH, location.origin);
            u.searchParams.set('url', origUrl);

            // Всегда кладём 'ua': ключ пресета или manual UA
            const mode = getMode();
            if (mode === 'manual') {
                const ua = (getManual() || '').trim();
                if (ua) u.searchParams.set('ua', ua);
                else u.searchParams.set('ua', 'wink');
            } else {
                u.searchParams.set('ua', getPresetKey()); // wink|chrome|...
            }
            return u.toString();
        } catch { return origUrl; }
    }

    // ---------- Network hook (fetch/XHR) ----------
    (function installNetworkHook(){
        const MEDIA_RE = /\.(m3u8|mpd|ts|m4s|mp4|webm|ogg|aac|mp3)(\?|#|$)/i;
        function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
        const ORI = escRe(location.origin);
        const PROXY_PATH_ESC = escRe(UA_PROXY_PATH);
        const PROXY_RE = new RegExp(`^${ORI}${PROXY_PATH_ESC}(?:\\?|$)`);

        function shouldProxy(url){
            if (!isEnabled()) return false;
            if (!url) return false;
            if (PROXY_RE.test(url)) return false;
            return MEDIA_RE.test(url);
        }
        function toProxy(url){
            if (!url) return url;
            try{
                if (PROXY_RE.test(url)) return url;
                return buildProxyUrl(url);
            } catch { return url; }
        }

        // fetch patch
        if (window.fetch && !window.__uaProxyFetchPatched){
            const origFetch = window.fetch.bind(window);

            function initFromRequest(req){
                const init = {
                    method: req.method,
                    headers: req.headers,
                    mode: req.mode,
                    credentials: req.credentials,
                    cache: req.cache,
                    redirect: req.redirect,
                    referrer: req.referrer === 'about:client' ? undefined : req.referrer,
                    referrerPolicy: req.referrerPolicy,
                    integrity: req.integrity,
                    keepalive: req.keepalive,
                    signal: req.signal
                };
                if (req.method && !/^(GET|HEAD)$/i.test(req.method)){
                    init.duplex = 'half';
                    try { init.body = req.clone().body; } catch {}
                }
                return init;
            }

            window.fetch = function(input, init){
                try{
                    let url = (typeof input === 'string') ? input : (input && input.url);
                    if (shouldProxy(url)){
                        const proxied = toProxy(url);
                        if (typeof input === 'string'){
                            input = proxied;
                        } else {
                            const base = initFromRequest(input);
                            const finalInit = Object.assign({}, base, init || {});
                            input = new Request(proxied, finalInit);
                        }
                    }
                } catch {}
                return origFetch(input, init);
            };

            window.__uaProxyFetchPatched = true;
        }

        // XHR patch
        if (window.XMLHttpRequest && !window.__uaProxyXHRPatched){
            const origOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, async, user, password){
                try { if (shouldProxy(url)) url = toProxy(url); } catch {}
                return origOpen.call(this, method, url, async, user, password);
            };
            window.__uaProxyXHRPatched = true;
        }

        // экспорт внутреннего
        window.__UAProxyInternals__ = { shouldProxy, toProxy, buildProxyUrl };
    })();

    // ---------- UA Tab markup ----------
    function uaTabMarkup(){
        const opts = Object.keys(UA_PRESETS).map(k => `<option value="${k}">${k.toUpperCase()}</option>`).join('');
        return `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <label style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" id="ua-proxy-enabled">
          <span><span data-i18n="ui.use_ua_proxy">${tr('ui.use_ua_proxy','Использовать прокси (User-Agent)')}</span></span>
        </label>

        <div style="display:flex;flex-direction:column;gap:6px;">
          <label style="display:flex;align-items:center;gap:8px;">
            <input type="radio" name="ua-mode" value="preset" checked>
            <span><span data-i18n="ui.preset">${tr('ui.preset','Пресет')}</span></span>
          </label>
          <select id="ua-preset" class="form-input" style="max-width:260px;">${opts}</select>
        </div>

        <div style="display:flex;flex-direction:column;gap:6px;">
          <label style="display:flex;align-items:center;gap:8px;">
            <input type="radio" name="ua-mode" value="manual">
            <span><span data-i18n="ui.custom">${tr('ui.custom','Пользовательский')}</span></span>
          </label>
          <input id="ua-manual" class="form-input" type="text" placeholder="Mozilla/5.0 ..." disabled>
        </div>

        <small class="ua-note" data-i18n="ui.ua_note">* ${tr('ui.ua_note','Изменение user-agent внутри браузера невозможно. Значение используется на сервере (user-agent-прокси).')}</small>
      </div>
    `;
    }

    // Вставка UI внутрь переданного контейнера
    function mount(root){
        if (!root) return;
        root.innerHTML = uaTabMarkup();

        if (!document.getElementById('ua-settings-inline-css')) {
            const css = `.ua-note{ font-size:12px; color:#aaa; }`;
            const el = document.createElement('style');
            el.id = 'ua-settings-inline-css';
            el.textContent = css;
            document.head.appendChild(el);
        }

        root.addEventListener('change', (e) => {
            if (e.target.name === 'ua-mode') {
                const manualEl = root.querySelector('#ua-manual');
                const selectEl = root.querySelector('#ua-preset');
                const manual = e.target.value === 'manual';
                if (manualEl) manualEl.disabled = !manual;
                if (selectEl) selectEl.disabled = manual;
            }
        });
    }

    function onOpen(container=document){
        const mode = getMode();
        $$('input[name="ua-mode"]', container).forEach(r => r.checked = (r.value === mode));

        const presetKey = getPresetKey();
        const sel = $('#ua-preset', container);
        if (sel){ sel.value = presetKey; sel.disabled = (mode !== 'preset'); }

        const manual = getManual();
        const manualEl = $('#ua-manual', container);
        if (manualEl){
            manualEl.value = manual;
            manualEl.disabled = (mode !== 'manual');
        }
        const ch = $('#ua-proxy-enabled', container);
        if (ch) ch.checked = isEnabled();
    }

    function saveFromUI(container=document){
        const checked = ($$('input[name="ua-mode"]', container).find(r => r.checked)) || { value: 'preset' };
        const mode = checked.value;
        const preset = ($('#ua-preset', container)?.value || 'wink');
        const manual = ($('#ua-manual', container)?.value || '').trim();
        const enabled = !!$('#ua-proxy-enabled', container)?.checked;
        setState({ enabled, mode, preset, manual });
    }

    // ---------- Public API ----------
    window.UASettings = {
        injectTabs(dialogEl){
            if (!dialogEl) return;
            const tabsBar = dialogEl.querySelector('.dialog-tabs');
            const bodyEl  = dialogEl.querySelector('.dialog-body');
            if (!tabsBar || !bodyEl) return;

            const uaTabBtn = document.createElement('div');
            uaTabBtn.className = 'dialog-tab';
            uaTabBtn.dataset.tab = 'ua-tab';
            uaTabBtn.innerHTML = `<span data-i18n="ui.user_agent">User-Agent</span>`;
            tabsBar.appendChild(uaTabBtn);

            const uaContent = document.createElement('div');
            uaContent.id = 'ua-tab';
            uaContent.className = 'dialog-content';
            bodyEl.appendChild(uaContent);

            mount(uaContent);
        },
        mount,
        onOpen,
        saveFromUI,
        isEnabled,
        getMode,
        getUAString,
        buildProxyUrl
    };
})();
