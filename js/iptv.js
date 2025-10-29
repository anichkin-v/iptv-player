// ===== CONFIGURATION & CONSTANTS =====
const CONFIG = Object.freeze({
    DB_NAME: 'IPTV-DB',
    DB_VERSION: 4,
    M3U8_EXPIRY: 365 * 24 * 60 * 60 * 1000,
    EPG_EXPIRY: 12 * 60 * 60 * 1000,
    EPG_TIMEZONE_OFFSET: 3,
    EPG_URL: '/epg.php?default=1',
    DEFAULT_PLAYLIST_URL: '/playlist.php?default=1',
    CHANNELS_PER_PAGE: 2500,
    NOTIFICATION_DURATION: 6000,
    EPG_UPDATE_INTERVAL: 5 * 60 * 1000,
    SEARCH_DEBOUNCE_DELAY: 200,
    MAX_CACHE_SIZE: 800,
    PLAYLIST_PROXY: '/user-agent-proxy.php',
    BATCH_SIZE: {
        low: 200,
        medium: 500,
        high: 1200
    },

    RECORDING: {
        enabled: true,
        defaultSegmentMinutes: 15,
        maxHoursPerFile: 6,
        fileNameTemplate: '{date}_{time}_{title}{seg}.',
        aspectRatio: {
            width: 16,
            height: 9,
            fps: 30
        },
        mimeCandidates: [
            'video/mp4;codecs="h264,aac"',
            'video/mp4;codecs="h265,aac"',
            'video/mp4;codecs="hev1,aac"',
            'video/mp4',
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm'
        ],
        ui: {
            recordButtonActiveClass: 'recording-active',
            recordButtonActiveColor: 'red'
        }
    },

    BUFFER_CONFIG: {
        low: { maxBufferLength: 60,  maxBufferSize: 10 * 1024 * 1024 },
        medium: { maxBufferLength: 180, maxBufferSize: 20 * 1024 * 1024 },
        high: { maxBufferLength: 420, maxBufferSize: 40 * 1024 * 1024 }
    }
});
function tr(key, fallback, vars) {
    const tfn = (window.I18N_AJAX && I18N_AJAX.t) || (window.I18N && I18N.t);
    let s = tfn ? tfn(key, vars) : null;
    if (!s) s = fallback || key;
    if (vars && s) {
        for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    }
    return s;
}
// ===== UTILITY CLASSES =====
class EventEmitter {
    constructor() { this.events = new Map(); }
    on(event, callback) {
        if (!this.events.has(event)) this.events.set(event, new Set());
        this.events.get(event).add(callback);
        return () => this.off(event, callback);
    }
    off(event, callback) {
        const set = this.events.get(event);
        if (set) { set.delete(callback); if (set.size === 0) this.events.delete(event); }
    }
    emit(event, ...args) {
        const handlers = this.events.get(event);
        if (!handlers) return;
        for (const cb of handlers) {
            try { cb(...args); } catch (error) { console.error('Event handler error:', error); }
        }
    }
    destroy() { this.events.clear(); }
}

// Простая LRU-Map (перемещаем ключ в конец при get/set).
class Cache extends Map {
    constructor(maxSize = CONFIG.MAX_CACHE_SIZE) { super(); this.maxSize = maxSize; }
    set(key, value) {
        if (this.has(key)) super.delete(key);
        super.set(key, value);
        if (this.size > this.maxSize) {
            const firstKey = this.keys().next().value;
            super.delete(firstKey);
        }
        return this;
    }
    setWithTTL(key, value, ttl) { this.set(key, { value, expiry: Date.now() + ttl }); }
    get(key) {
        const item = super.get(key);
        if (item?.expiry && Date.now() > item.expiry) { super.delete(key); return undefined; }
        if (item !== undefined) { // LRU touch
            super.delete(key); super.set(key, item);
        }
        return item?.value ?? item;
    }
}

class Performance {
    static _level = null;
    static detectLevel() {
        if (this._level) return this._level;
        const memory = navigator.deviceMemory || 4;
        const cores = navigator.hardwareConcurrency || 2;
        this._level = (memory <= 2 || cores <= 2) ? 'low' : (memory >= 8 && cores >= 4) ? 'high' : 'medium';
        return this._level;
    }
}

// ===== CHANNEL NAME NORMALIZER =====
class ChannelNameNormalizer {
    static _reParens = /\([^)]*\)/g;
    static _rePlusNum = /\+\d+\s*/g;
    static _reQual = /\b(HD|FHD|UHD|4K|SD)\b/gi;
    static _reNonWord = /[^\wа-яё\s]/gi;
    static _reSpaces = /\s+/g;
     static getCommon() {
        const tt = (k, fb) => (window.I18N_AJAX && typeof I18N_AJAX.t === 'function'
        ? I18N_AJAX.t(k, fb || k) : (fb || k));
        const set = new Set([
            tt('ui.радио','радио').toLowerCase(), 'radio',
            tt('ui.тв','тв').toLowerCase(), 'tv',
            tt('ui.кино','кино').toLowerCase(), 'kino','music','музыка','muz','муз',
            tt('ui.новое','новое').toLowerCase(), 'new','yangi'
            ]);
        return set;
        }

    static normalizeChannelName(name) {
        if (!name || typeof name !== 'string') return '';
        return name
            .replace(this._reParens, '')
            .replace(this._rePlusNum, '')
            .replace(this._reQual, '')
            .replace(this._reNonWord, '')
            .replace(this._reSpaces, ' ')
            .trim()
            .toLowerCase();
    }
    static extractKeywords(name) {
        const normalized = this.normalizeChannelName(name);
        return normalized.split(/\s+/).filter(w => w.length > 1);
    }
    static getChannelVariants(name) {
        const variants = new Set();
        const original = (name || '').toLowerCase().trim();
        if (original) variants.add(original);
        const normalized = this.normalizeChannelName(name);
        if (normalized) variants.add(normalized);
        const withoutNumbers = normalized.replace(/\d+/g, '').trim();
        if (withoutNumbers) variants.add(withoutNumbers);
        const mainWord = normalized.split(/\s+/)[0];
        if (mainWord && mainWord.length > 2 && !this.getCommon().has(mainWord)) variants.add(mainWord);
        return Array.from(variants).filter(Boolean);
    }
}

// ===== STREAM FORMAT DETECTOR =====
class StreamFormatDetector {
    static detectFormat(url) {
        if (!url) return { type: 'mp4', mimeType: 'video/mp4', isLive: false };
        const lower = url.toLowerCase();
        const clean = lower.split('?')[0];
        const protocol = lower.split(':',1)[0];
        if (protocol === 'rtmp' || protocol === 'rtmps') return { type: 'rtmp', mimeType: 'video/mp4', isLive: true, unsupported: true };
        if (protocol === 'rtsp' || protocol === 'rtsps') return { type: 'rtsp', mimeType: 'video/mp4', isLive: true, unsupported: true };
        if (clean.includes('.m3u8') || clean.includes('.m3u') || lower.includes('/hls/') || lower.includes('type=hls'))
            return { type: 'hls', mimeType: 'application/x-mpegURL', isLive: true };
        if (clean.includes('.mpd') || lower.includes('/dash/') || lower.includes('type=dash'))
            return { type: 'dash', mimeType: 'application/dash+xml', isLive: true };
        return { type: 'mp4', mimeType: 'video/mp4', isLive: false };
    }
}

// ===== GLOBAL STATE MANAGER =====
class AppState extends EventEmitter {
    constructor() {
        super();
        this.data = {
            db: null,
            currentChannel: null,
            channels: [],
            epgData: {},
            groups: [],
            filteredChannels: [],
            searchQuery: '',
            selectedGroup: '',
            devicePerformance: Performance.detectLevel()
        };
        this.caches = {
            render: new Cache(100),
            epg: new Cache(1000),
            timeparse: new Cache(1000),
            channelMatch: new Cache(CONFIG.MAX_CACHE_SIZE),
            currentProgram: new Cache(50)
        };
    }
    get(key) { return this.data[key]; }
    set(key, value) {
        const oldValue = this.data[key];
        if (oldValue === value) return this;
        this.data[key] = value;
        this.emit('stateChange', { key, value, oldValue });
        return this;
    }
    update(updates) { for (const [k,v] of Object.entries(updates)) this.set(k,v); return this; }
    getCache(type) { return this.caches[type]; }
    clearCaches() { Object.values(this.caches).forEach(c => c.clear()); }
    destroy() { this.clearCaches(); super.destroy(); }
}

// ===== DATABASE MANAGER =====
class DatabaseManager {
    constructor() { this.db = null; }
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                ['playlists','epg'].forEach(storeName => {
                    if (db.objectStoreNames.contains(storeName)) db.deleteObjectStore(storeName);
                    db.createObjectStore(storeName, { keyPath: 'url' });
                });
            };
            request.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
            request.onerror = () => reject(request.error || new Error('IndexedDB open error'));
        });
    }
    async store(storeName, data) {
        const tx = this.db.transaction(storeName, 'readwrite');
        return new Promise((resolve, reject) => {
            const req = tx.objectStore(storeName).put(data);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error || new Error('IndexedDB put error'));
        });
    }
    async get(storeName, key) {
        const tx = this.db.transaction(storeName, 'readonly');
        return new Promise((resolve) => {
            const req = tx.objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    }
    async getAll(storeName) {
        const tx = this.db.transaction(storeName, 'readonly');
        return new Promise((resolve) => {
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    }
    async clear(storeName) {
        const tx = this.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
    }
}

// ===== NOTIFICATION SYSTEM =====
class NotificationManager {
    constructor() {
        this.container = null;
        this._styleEl = null;
        this.init();
    }

    init() {
        this.createContainer();
        this.addStyles();
    }

    createContainer() {
        if (document.getElementById('notification-container')) {
            this.container = document.getElementById('notification-container');
            return;
        }
        const el = document.createElement('div');
        el.id = 'notification-container';
        el.style.cssText = 'position:fixed;top:20px;right:20px;z-index:10000;pointer-events:none;';
        document.body.appendChild(el);
        this.container = el;
    }

    addStyles() {
        if (document.getElementById('notification-styles')) return;
        const style = document.createElement('style');
        style.id = 'notification-styles';
        style.textContent = `
        .notification-popup{background:#2c2b2b;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);padding:16px 20px;margin-bottom:10px;min-width:300px;max-width:400px;pointer-events:all;transform:translateX(400px);transition:transform .3s ease-out;display:flex;align-items:center;gap:12px;position:relative}
        .notification-popup.show{transform:translateX(0)}
        .notification-popup.success{border-left:4px solid #4CAF50}
        .notification-popup.error{border-left:4px solid #f44336}
        .notification-popup.info{border-left:4px solid #2196F3}
        .notification-icon{font-size:24px;flex-shrink:0}
        .notification-icon.success{color:#4CAF50}
        .notification-icon.error{color:#f44336}
        .notification-icon.info{color:#2196F3}
        .notification-content{flex:1}
        .notification-title{font-weight:600;margin-bottom:4px;color:#9f9e9e}
        .notification-message{color:#9f9e9e;font-size:14px}
        .notification-close{position:absolute;top:8px;right:8px;background:none;border:0;color:#999;font-size:20px;cursor:pointer;padding:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:4px;transition:background .2s}
        .notification-close:hover{background:#333232;color:#9f9e9e}`;
        document.head.appendChild(style);
        this._styleEl = style;
    }

    // Функция для безопасного получения перевода
    _translate(text) {
        if (!text || typeof text !== 'string') return text;

        // Проверяем доступность I18N_AJAX и переводим
        if (window.I18N_AJAX?.translateText) {
            return window.I18N_AJAX.translateText(text);
        }

        return text;
    }

    // Escape HTML для безопасности
    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    show(title, message, type='success', duration=typeof CONFIG !== 'undefined' ? CONFIG.NOTIFICATION_DURATION : 3000) {
        if (!this.container) this.createContainer();

        // Переводим title и message перед созданием элемента
        const translatedTitle = this._translate(title || '');
        const translatedMessage = this._translate(message || '');

        // Escape HTML для безопасности
        const safeTitle = this._escapeHtml(translatedTitle);
        const safeMessage = translatedMessage ? this._escapeHtml(translatedMessage) : '';

        // Создаем элемент
        const el = document.createElement('div');
        el.className = `notification-popup ${type}`;

        // Создаем содержимое с переведенным текстом
        const iconMap = {
            'success': '✓',
            'error': '✕',
            'info': 'ℹ'
        };

        el.innerHTML = `
            <div class="notification-icon ${type}">${iconMap[type] || 'ℹ'}</div>
            <div class="notification-content">
                <div class="notification-title">${safeTitle}</div>
                ${safeMessage ? `<div class="notification-message">${safeMessage}</div>` : ''}
            </div>
            <button class="notification-close" aria-label="Close">&times;</button>`;

        this.container.appendChild(el);

        // Применяем i18n переводы к элементу (на случай если есть data-i18n атрибуты)
        if (window.I18N_AJAX?.apply) {
            window.I18N_AJAX.apply(el);
        }

        // Показываем уведомление
        requestAnimationFrame(() => el.classList.add('show'));

        const close = () => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 300);
        };

        el.querySelector('.notification-close').addEventListener('click', close, { once: true });
        if (duration > 0) setTimeout(close, duration);

        return el;
    }

    // Метод для показа уведомления с сырыми ключами (для отладки)
    showRaw(title, message, type='success', duration) {
        console.log('Raw notification:', { title, message, type });
        return this.show(title, message, type, duration);
    }

    // Метод для принудительного перевода всех активных уведомлений
    translateAll() {
        if (!this.container) return;

        const notifications = this.container.querySelectorAll('.notification-popup');
        notifications.forEach(notification => {
            const titleEl = notification.querySelector('.notification-title');
            const messageEl = notification.querySelector('.notification-message');

            if (titleEl && titleEl.textContent) {
                const translatedTitle = this._translate(titleEl.textContent);
                if (translatedTitle !== titleEl.textContent) {
                    titleEl.textContent = translatedTitle;
                }
            }

            if (messageEl && messageEl.textContent) {
                const translatedMessage = this._translate(messageEl.textContent);
                if (translatedMessage !== messageEl.textContent) {
                    messageEl.textContent = translatedMessage;
                }
            }
        });
    }

    destroy() {
        if (this.container) this.container.remove();
        if (this._styleEl) this._styleEl.remove();
    }
}

// === Интеграция с системой i18n ===
// Автоматически переводим уведомления при смене языка
document.addEventListener('i18n:lang-changed', () => {
    // Если есть глобальный экземпляр NotificationManager
    if (typeof notifications !== 'undefined' && notifications.translateAll) {
        notifications.translateAll();
    }

    // Альтернативно, ищем все контейнеры уведомлений
    const containers = document.querySelectorAll('#notification-container');
    containers.forEach(container => {
        if (window.I18N_AJAX?.forceTranslateNotifications) {
            window.I18N_AJAX.forceTranslateNotifications();
        }
    });
});


// ===== TIME MANAGER =====
class TimeManager {
    constructor() {
        this.userOffset = -new Date().getTimezoneOffset() / 60;
        this.epgOffset = CONFIG.EPG_TIMEZONE_OFFSET;
        this.diff = this.userOffset - this.epgOffset;
        this.parseCache = new Cache(500);
    }
    parseEPGTime(timeStr){
        const ts = String(timeStr || '');
        const base = ts.slice(0,14);
        if (base.length !== 14) return new Date();
        const iso = `${base.slice(0,4)}-${base.slice(4,6)}-${base.slice(6,8)}T${base.slice(8,10)}:${base.slice(10,12)}:${base.slice(12,14)}`;
        const tz = ts.slice(15).trim();
        if (/^[\+\-]\d{4}$/.test(tz)) return new Date(`${iso}${tz.replace(/(\+|\-)(\d{2})(\d{2})/,'$1$2:$3')}`);
        return new Date(`${iso}Z`);
    }
    formatTime(date) { return date.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', hour12:false }); }
    getTimezoneDisplay() {
        return ''; // вывод отключён
    }
}

// ===== EPG MANAGER =====
class EPGManager extends EventEmitter {
    constructor(database, timeManager) {
        super();
        this.db = database;
        this.timeManager = timeManager;
        this.epgCache = {}; // {id:{names:[],icon,programs:[]}}
        this.matchCache = new Cache(CONFIG.MAX_CACHE_SIZE);
        this.programCache = new Cache(50);
        this.updateTimer = null;

        // Быстрые индексы для матчей
        this._indexExact = new Map();       // exact lower-case name -> id
        this._indexNormalized = new Map();  // normalized name -> id

        this.channelTypeKeywords = {
            radio: [`${t('ui.радио')}`,'radio','fm'],
            tv: [`${t('ui.тв')}`,'tv',`${t('ui.телеканал')}`,'channel'],
            movie: [`${t('ui.кино')}`,'movie','cinema','film'],
            music: ['music',`${t('ui.музыка')}`,'mtv',`${t('ui.муз')}`]
        };
        this.channelTypeCache = new Map();
        this._domParser = new DOMParser();
    }

    async load(forceRefresh = false) {
        if (!forceRefresh) {
            const cached = await this.db.get('epg', CONFIG.EPG_URL);
            if (cached?.timestamp && (Date.now() - cached.timestamp) < CONFIG.EPG_EXPIRY) {
                this.parseEPG(cached.data);
                this.emit('loaded', this.epgCache);
                return;
            }
        }
        await this.fetchFromServer();
    }

    async fetchFromServer() {
        try {
            const response = await fetch(CONFIG.EPG_URL, {
                method: 'GET',
                mode: 'cors',
                cache: 'no-cache',
                headers: { 'Accept': 'application/xml, text/xml, */*' }
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const text = await response.text();
            await this.db.store('epg', { url: CONFIG.EPG_URL, data: text, timestamp: Date.now() });
            this.parseEPG(text);
            this.emit('loaded', this.epgCache);
        } catch (error) {
            try {
                const cached = await this.db.get('epg', CONFIG.EPG_URL);
                if (cached) {
                    this.parseEPG(cached.data);
                    this.emit('loaded', this.epgCache);
                    this.emit('offline', `${t('ui.загружена')} ${t('ui.из')} ${t('ui.кэша')} (${t('ui.офлайн')} ${t('ui.режим')})`);
                    return;
                }
            } catch(_) { /* ignore */ }
            this.emit('error', error);
            console.error('EPG fetch error:', error);
        }
    }

    parseEPG(xmlText) {
        this.epgCache = {};
        this._indexExact.clear();
        this._indexNormalized.clear();

        const xmlDoc = this._domParser.parseFromString(xmlText, 'text/xml');
        const channels = xmlDoc.getElementsByTagName('channel');

        for (let i=0; i<channels.length; i++) {
            const ch = channels[i];
            const id = ch.getAttribute('id');
            if (!id) continue;
            const displayNames = [];
            const dn = ch.getElementsByTagName('display-name');
            for (let j=0; j<dn.length; j++) {
                const t = dn[j].textContent;
                if (t) displayNames.push(t.trim());
            }
            const iconEl = ch.getElementsByTagName('icon')[0];
            const iconSrc = iconEl?.getAttribute('src') || null;

            this.epgCache[id] = { names: displayNames, icon: iconSrc, programs: [] };

            // Индексация
            for (const name of displayNames) {
                const lc = name.toLowerCase().trim();
                if (lc) this._indexExact.set(lc, id);
                const norm = ChannelNameNormalizer.normalizeChannelName(name);
                if (norm) this._indexNormalized.set(norm, id);
            }
        }

        const programs = xmlDoc.getElementsByTagName('programme');
        for (let i=0; i<programs.length; i++) {
            const pr = programs[i];
            const channelId = pr.getAttribute('channel');
            const start = pr.getAttribute('start');
            const stop = pr.getAttribute('stop');
            if (!channelId || !start || !stop) continue;

            const titleEl = pr.getElementsByTagName('title')[0];
            const descEl = pr.getElementsByTagName('desc')[0];
            const title = titleEl?.textContent?.trim() || `${t('ui.нет')} ${t('ui.названия')}`;
            const desc = descEl?.textContent?.trim() || '';

            const ch = this.epgCache[channelId];
            if (ch) ch.programs.push({ start, stop, title, desc });
        }

        // Сортировка программ
        for (const ch of Object.values(this.epgCache)) {
            if (ch.programs.length > 1) {
                ch.programs.sort((a, b) => a.start.localeCompare(b.start));
            }
        }
    }

    getChannelType(name) {
        if (this.channelTypeCache.has(name)) return this.channelTypeCache.get(name);
        const normalized = (name || '').toLowerCase();
        let type = 'unknown';
        for (const [channelType, keywords] of Object.entries(this.channelTypeKeywords)) {
            if (keywords.some(k => normalized.includes(k))) { type = channelType; break; }
        }
        this.channelTypeCache.set(name, type);
        return type;
    }
    areChannelTypesCompatible(channelName, epgName) {
        const t1 = this.getChannelType(channelName);
        const t2 = this.getChannelType(epgName);
        if (t1 === 'unknown' || t2 === 'unknown') return true;
        if (t1 === 'radio') return t2 === 'radio';
        if (t1 === 'tv' && t2 === 'radio') return false;
        if (t1 === 'movie' && t2 === 'radio') return false;
        return true;
    }

    findMatchingChannel(channelName) {
        if (!channelName) return null;
        const cached = this.matchCache.get(channelName);
        if (cached) return cached;

        // 1) точное совпадение (lower-case)
        const lc = channelName.toLowerCase().trim();
        let id = this._indexExact.get(lc);
        if (id) return this._cacheMatch(channelName, id);

        // 2) нормализованное совпадение
        const norm = ChannelNameNormalizer.normalizeChannelName(channelName);
        id = this._indexNormalized.get(norm);
        if (id) return this._cacheMatch(channelName, id);

        // 3) вариации/ключевые слова + совместимость типов
        const channelVariants = ChannelNameNormalizer.getChannelVariants(channelName);
        for (const v of channelVariants) {
            const id2 = this._indexNormalized.get(v);
            if (id2) {
                const data = this.epgCache[id2];
                if (data?.names?.some(n => this.areChannelTypesCompatible(channelName, n))) {
                    return this._cacheMatch(channelName, id2);
                }
            }
        }

        // 4) мягкие совпадения по ключевым словам
        const mainKeywords = ChannelNameNormalizer.extractKeywords(channelName).filter(w=>w.length>2);
        if (mainKeywords.length) {
            for (const [cid, data] of Object.entries(this.epgCache)) {
                for (const epgName of data.names) {
                    if (!this.areChannelTypesCompatible(channelName, epgName)) continue;
                    const epgKeywords = ChannelNameNormalizer.extractKeywords(epgName);
                    const allMatch = mainKeywords.every(k => epgKeywords.some(ek => ek.includes(k) || k.includes(ek)));
                    const epgMain = epgKeywords.filter(w=>w.length>2);
                    const noExtra = epgMain.length <= mainKeywords.length + 1;
                    if (allMatch && noExtra) return this._cacheMatch(channelName, cid);
                }
            }
        }

        // 5) похожесть первого слова
        if (mainKeywords.length === 1 && mainKeywords[0].length >= 4) {
            const sw = mainKeywords[0];
            for (const [cid, data] of Object.entries(this.epgCache)) {
                for (const epgName of data.names) {
                    if (!this.areChannelTypesCompatible(channelName, epgName)) continue;
                    const epgKeywords = ChannelNameNormalizer.extractKeywords(epgName).filter(w=>w.length>=4);
                    for (const ek of epgKeywords) {
                        if (this.isSimilar(sw, ek, 0.85)) return this._cacheMatch(channelName, cid);
                    }
                }
            }
        }

        // 6) похожесть первого слова (короткий список)
        const first = mainKeywords[0];
        if (first && first.length > 3 && mainKeywords.length <= 2) {
            for (const [cid, data] of Object.entries(this.epgCache)) {
                for (const epgName of data.names) {
                    if (!this.areChannelTypesCompatible(channelName, epgName)) continue;
                    const epgKeywords = ChannelNameNormalizer.extractKeywords(epgName);
                    const ef = epgKeywords[0];
                    if (ef && epgKeywords.length <= 3) {
                        if (ef === first || this.isSimilar(first, ef, 0.8)) return this._cacheMatch(channelName, cid);
                    }
                }
            }
        }

        this.matchCache.set(channelName, null);
        return null;
    }

    _cacheMatch(channelName, channelId) {
        const data = this.epgCache[channelId];
        const result = { channelId, ...data };
        this.matchCache.set(channelName, result);
        return result;
    }

    isSimilar(a,b,threshold=0.7) {
        if (!a || !b) return false;
        const maxLen = Math.max(a.length, b.length);
        if (maxLen === 0) return true;
        const dist = this.levenshteinDistance(a,b);
        return (maxLen - dist) / maxLen >= threshold;
    }
    levenshteinDistance(a,b) {
        const n = a.length, m = b.length;
        if (n === 0) return m; if (m === 0) return n;
        const prev = new Uint16Array(m+1);
        const curr = new Uint16Array(m+1);
        for (let j=0;j<=m;j++) prev[j]=j;
        for (let i=1;i<=n;i++) {
            curr[0]=i;
            const ca=a.charCodeAt(i-1);
            for (let j=1;j<=m;j++) {
                const cost = (ca===b.charCodeAt(j-1)) ? 0 : 1;
                curr[j] = Math.min(prev[j]+1, curr[j-1]+1, prev[j-1]+cost);
            }
            prev.set(curr);
        }
        return curr[m];
    }

    getCurrentProgram(channelName, epgData) {
        const programs = epgData?.programs;
        if (!programs || programs.length === 0) return `${t('ui.информация')} ${t('ui.о')} ${t('ui.программе')} ${t('ui.недоступна')}`;
        const now = Date.now();

        // бинарный поиск по старту
        let lo = 0, hi = programs.length - 1, idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const s = this.timeManager.parseEPGTime(programs[mid].start).getTime();
            if (s <= now) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
        }

        if (idx >= 0) {
            const p = programs[idx];
            const end = this.timeManager.parseEPGTime(p.stop);
            if (now < end.getTime()) return `${p.title} • до ${this.timeManager.formatTime(end)}`;
        }

        // следующая передача
        const nextIdx = Math.max(0, idx + 1);
        if (nextIdx < programs.length) {
            const p = programs[nextIdx];
            const start = this.timeManager.parseEPGTime(p.start);
            return `Далее: ${p.title} • в ${this.timeManager.formatTime(start)}`;
        }

        return `${t('ui.информация')} ${t('ui.о')} ${t('ui.программе')} ${t('ui.недоступна')}`;
    }

    getProgressBar(epgData) {
        const programs = epgData?.programs;
        if (!programs || programs.length === 0) return '';
        const now = Date.now();

        // бинарный поиск текущей
        let lo = 0, hi = programs.length - 1, idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const s = this.timeManager.parseEPGTime(programs[mid].start).getTime();
            if (s <= now) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        if (idx >= 0) {
            const p = programs[idx];
            const start = this.timeManager.parseEPGTime(p.start).getTime();
            const end = this.timeManager.parseEPGTime(p.stop).getTime();
            if (now < end) {
                const progress = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
                return `<div class="channel-progress-container"><div class="channel-progress-bar" style="width:${progress.toFixed(1)}%"></div></div>`;
            }
        }
        return '';
    }

    startUpdates() {
        this.stopUpdates();
        this.updateTimer = setInterval(() => {
            this.programCache.clear();

            this.timeManager.parseCache.clear();
            this.emit('update');
        }, CONFIG.EPG_UPDATE_INTERVAL);
    }
    stopUpdates() {
        if (this.updateTimer) { clearInterval(this.updateTimer); this.updateTimer = null; }
    }
    async refresh() {
        await this.db.clear('epg');

        this.programCache.clear();
        this.channelTypeCache.clear();
        await this.load(true);
    }
    destroy() {
        this.stopUpdates();
        this.channelTypeCache.clear();
        super.destroy();
    }
}

/// ===== PLAYLIST MANAGER =====
class PlaylistManager extends EventEmitter {
    constructor(database) {
        super();
        this.db = database;
        this.channels = [];
        this.groups = [];
        this.supportedFormats = {
            extensions: ['.m3u','.m3u8','.txt'],
            mimeTypes: [
                'application/x-mpegurl','application/vnd.apple.mpegurl','audio/mpegurl',
                'audio/x-mpegurl','video/x-mpegurl','video/mpegurl','application/m3u8',
                'audio/m3u8','text/plain','application/octet-stream'
            ]
        };
    }

    // ---- ХЕЛПЕРЫ КАК МЕТОДЫ КЛАССА ----
    normalizeUrl(input) {
        if (!input) throw new Error('Пустой URL');
        const s = String(input).trim();
        const compact = s.replace(/\s+/g, '');
        const fixed = compact.replace(/^(.*?)(https?:\/\/)/i, '$2');
        try {
            return new URL(fixed, window.location.origin).href;
        } catch {
            throw new Error('Некорректный URL плейлиста');
        }
    }

    toFetchableUrl(raw) {
        const u = new URL(this.normalizeUrl(raw), window.location.origin);
        if (u.origin === window.location.origin) return u.href;
        const proxyBase = new URL(CONFIG.PLAYLIST_PROXY, window.location.origin);
        proxyBase.searchParams.set('url', u.href);
        return proxyBase.href;
    }

    // без кастомных заголовков, чтобы не вызывать preflight
    async safeFetchText(href) {
        const res = await fetch(href, {
            method: 'GET',
            mode: 'cors',
            cache: 'no-cache',
            redirect: 'follow',
            credentials: 'omit',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    }

    // ===== заменить ваш метод =====
    async loadFromUrl(url) {
        try {
            const finalUrl = this.toFetchableUrl(url);              // <— было toFetchableUrl(...)
            const format   = this.detectPlaylistFormat(url);
            const text     = await this.safeFetchText(finalUrl);    // <— было safeFetchText(...)
            if (!text) throw new Error(`${t('ui.пустой')} ${t('ui.ответ')} ${t('ui.от')} ${t('ui.сервера')}`);
            this.validatePlaylistContent(text, format);
            return this.processPlaylist(text, url);
        } catch (error) {
            this.emit('error', error);
            console.error('Playlist loadFromUrl error:', error);
            throw new Error(`Не удалось загрузить плейлист: ${error.message}`);
        }
    }


    async loadFromFile(file) {
        const format = this.detectPlaylistFormat(file.name);
        if (!this.isValidPlaylistFile(file)) throw new Error(`Поддерживаются только файлы ${this.supportedFormats.extensions.join(', ')}`);
        try {
            let text = await this.readFileAsText(file);
            try { this.validatePlaylistContent(text, format); }
            catch (e) {
                if (e.message.includes(`${t('ui.кодиров')}`)) { text = await this.readFileAsText(file,'windows-1251'); this.validatePlaylistContent(text, format); }
                else throw e;
            }
            return this.processPlaylist(text, 'file_' + file.name);
        } catch (error) {
            this.emit('error', error);
            console.error('Playlist loadFromFile error:', error);
            throw error;
        }
    }

    detectPlaylistFormat(nameOrUrl) {
        const s = (nameOrUrl || '').toLowerCase();
        if (s.includes('.m3u8') || s.includes('m3u8')) return 'm3u8';
        if (s.includes('.m3u')  || s.includes('m3u'))  return 'm3u';
        return 'm3u8';
    }
    isValidPlaylistFile(file) {
        const fn = file.name.toLowerCase();
        const okExt = this.supportedFormats.extensions.some(ext => fn.endsWith(ext));
        const okMime = !file.type ||
            this.supportedFormats.mimeTypes.includes(file.type) ||
            file.type.startsWith('text/') || file.type === 'application/octet-stream';
        return okExt && okMime;
    }

    validatePlaylistContent(text, format) {
        if (!text || typeof text !== 'string') throw new Error(`${t('ui.некорректное')} ${t('ui.содержимое')} ${t('ui.файла')}`);
        const trimmed = text.trim();
        if (trimmed.length === 0) throw new Error(`${t('ui.файл')} ${t('ui.пуст')}`);
        const hasHeader = trimmed.startsWith('#EXTM3U') || trimmed.includes('#EXTM3U');
        const hasExtInf = trimmed.includes('#EXTINF');
        const hasUrls = /^(https?|rtmp|rtsp):\/\//im.test(trimmed);
        if (!hasHeader && !hasExtInf && !hasUrls) throw new Error(`${t('ui.файл')} ${t('ui.не')} ${t('ui.является')} ${t('ui.валидным')} M3U/M3U8 ${t('ui.плейлистом')}`);
        if (this.hasEncodingIssues(trimmed)) throw new Error(`${t('ui.возможны')} ${t('ui.проблемы')} ${t('ui.с')} ${t('ui.кодировкой')} ${t('ui.файла')}`);
        if (format === 'm3u8') this.validateM3U8Specific(trimmed);
    }
    hasEncodingIssues(text) {
        return /[ÃÂ]{2,}/.test(text) || /Ð{2,}/.test(text) || /[Ã¢Â€Â™Ã¢Â€ÂœÃ¢Â€Â]/.test(text);
    }
    validateM3U8Specific(text) {
        void text; return true;
    }

    readFileAsText(file, encoding='utf-8') {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => {
                try {
                    let res = e.target.result;
                    if (res && res.charCodeAt && res.charCodeAt(0) === 0xFEFF) res = res.slice(1);
                    resolve(res);
                } catch(err) { reject(new Error(`${t('ui.ошибка')} ${t('ui.обработки')} ${t('ui.файла')}`)); }
            };
            reader.onerror = () => reject(new Error(`${t('ui.ошибка')} ${t('ui.чтения')} ${t('ui.файла')}`));
            reader.readAsText(file, encoding);
        });
    }

    async processPlaylist(playlistText, url) {
        try {
            await this.db.clear('playlists');
            await this.db.store('playlists', { url, data: playlistText, timestamp: Date.now(), format: this.detectPlaylistFormat(url) });
            this.parseM3U8(playlistText);
            const payload = { channels: this.channels, groups: this.groups, url, format: this.detectPlaylistFormat(url) };
            this.emit('loaded', payload);
            return { channels: this.channels, groups: this.groups, format: this.detectPlaylistFormat(url) };
        } catch (error) {
            this.emit('error', error);
            console.error('Playlist process error:', error);
            throw new Error(`Ошибка обработки плейлиста: ${error.message}`);
        }
    }

    parseM3U8(text) {
        this.channels = [];
        this.groups = [];
        const groupSet = new Set();
        let currentChannel = null;
        const lines = text.split(/\r?\n/);

        for (let i=0;i<lines.length;i++) {
            const line = lines[i].trim();
            if (!line) continue;

            if (line.startsWith('#EXTINF:')) {
                currentChannel = this.parseExtinf(line);
            } else if (line.startsWith('#EXTGRP:')) {
                if (currentChannel && !currentChannel.group) currentChannel.group = line.slice(8).trim();
            } else if (line.startsWith('#')) {
                continue;
            } else if (this.isValidUrl(line)) {
                if (currentChannel) {
                    currentChannel.url = line;
                    currentChannel.format = StreamFormatDetector.detectFormat(line);
                    if (!currentChannel.name) currentChannel.name = `Канал ${this.channels.length + 1}`;
                    if (!currentChannel.group) currentChannel.group = `${t('ui.без')} ${t('ui.группы')}`;
                    groupSet.add(currentChannel.group);
                    this.channels.push(currentChannel);
                    currentChannel = null;
                }
            }
        }
        this.groups = Array.from(groupSet).sort();
    }

    parsePlaylist(text) { return this.parseM3U8(text); }

    parseExtinf(line) {
        const extinf = line.slice(8);
        const channel = {};
        const commaIndex = extinf.lastIndexOf(',');
        if (commaIndex === -1) { channel.name = extinf.trim(); return channel; }

        const attributesStr = extinf.slice(0, commaIndex).trim();
        channel.name = extinf.slice(commaIndex + 1).trim();

        // Быстрые регулярки без флагов глобальной рекомпиляции
        const quotedAttrRegex = /([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g;
        let m;
        while ((m = quotedAttrRegex.exec(attributesStr)) !== null) {
            const attr = m[1], val = m[2];
            channel[attr] = val;
            if (attr === 'group-title') channel.group = val;
            else if (attr === 'tvg-logo') channel.icon = val;
        }
        const unquotedAttrRegex = /([a-zA-Z][\w-]*)\s*=\s*([^\s"]+)/g;
        while ((m = unquotedAttrRegex.exec(attributesStr)) !== null) {
            const attr = m[1], val = m[2];
            if (!channel[attr]) {
                channel[attr] = val;
                if (attr === 'tvg-logo') channel.icon = val;
            }
        }
        return channel;
    }

    isValidUrl(url) { return /^(https?|rtmp|rtmps|rtsp|rtsps):\/\//i.test(url); }

    getPlaylistStats() {
        const stats = { totalChannels: this.channels.length, totalGroups: this.groups.length, groupDistribution: {}, formatDistribution: {} };
        for (const ch of this.channels) {
            const group = ch.group || `${t('ui.без')} ${t('ui.группы')}`;
            stats.groupDistribution[group] = (stats.groupDistribution[group] || 0) + 1;
            const fmt = ch.format?.type || 'unknown';
            stats.formatDistribution[fmt] = (stats.formatDistribution[fmt] || 0) + 1;
        }
        return stats;
    }
}

// ===== RENDERER =====
class ChannelRenderer {
    constructor(epgManager, appState) { this.epgManager = epgManager; this.appState = appState; }
    renderChannels(container, channels, filter = '', group = '') {
        if (!container) return [];
        const filtered = this.filterChannels(channels, filter, group);
        if (filtered.length === 0) { container.innerHTML = `<div class="no-results">${t('ui.каналы')} ${t('ui.не')} ${t('ui.найдены')}</div>`; return []; }

        const perf = this.appState.get('devicePerformance');
        const batchSize = CONFIG.BATCH_SIZE[perf];
        const toRender = filtered.slice(0, batchSize);

        this.renderBatch(container, toRender);
        if (filtered.length > batchSize) this.addLoadMoreButton(container, filtered, batchSize);
        return filtered;
    }
    filterChannels(channels, filter, group) {
        if (!filter && !group) return channels;
        const f = (filter || '').toLowerCase();
        return channels.filter(ch => {
            const nameMatch = !f || ch.name.toLowerCase().includes(f);
            const groupMatch = !group || ch.group === group;
            return nameMatch && groupMatch;
        });
    }
    renderBatch(container, channels) {
        container.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (const ch of channels) frag.appendChild(this.createChannelElement(ch));
        container.appendChild(frag);
    }
    createChannelElement(channel) {
        const epgData = this.epgManager.findMatchingChannel(channel.name);
        const currentProgram = this.epgManager.getCurrentProgram(channel.name, epgData);
        const progressBar = this.epgManager.getProgressBar(epgData);

        const el = document.createElement('div');
        el.className = 'channel-item';
        el.dataset.url = channel.url;
        el.tabIndex = 0;

// Приоритет иконок: 1) из плейлиста, 2) из EPG, 3) заглушка
        let logoSrc = '/css/no_logo.png';
        const plIcon = channel.icon || channel['tvg-logo'] || channel['logo'] || channel['tvg_logo'];
        if (plIcon) logoSrc = plIcon;
        else if (epgData?.icon) logoSrc = epgData.icon;


        el.innerHTML = `
            <img class="channel-logo" src="${logoSrc}" alt="${channel.name}"
                 onerror="this.onerror=null;this.src='/css/no_logo.png';"
                 onload="this.style.opacity='1';" style="opacity:.5;transition:opacity .3s;">
            <div class="channel-info">
                <div class="channel-name" title="${channel.name}">${channel.name}</div>
                <div class="channel-program" title="${currentProgram}">${currentProgram}</div>
                ${progressBar}
            </div>`;

        const currentChannel = this.appState.get('currentChannel');
        if (currentChannel?.url === channel.url) el.classList.add('active');

        const select = () => {
            const fresh = this.epgManager.findMatchingChannel(channel.name);
            this.appState.emit('channelSelected', { channel, epgData: fresh });
        };
        el.addEventListener('click', select);
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
        });
        return el;
    }
    addLoadMoreButton(container, filtered, currentCount) {
        const wrap = document.createElement('div');
        wrap.className = 'load-more-btn';
        const remain = filtered.length - currentCount;
        wrap.innerHTML = `<button class="btn btn-secondary">Показать еще (${remain})</button>`;
        wrap.firstElementChild.addEventListener('click', () => {
            const perf = this.appState.get('devicePerformance');
            const batch = CONFIG.BATCH_SIZE[perf];
            const next = filtered.slice(currentCount, currentCount + batch);
            wrap.remove();
            const frag = document.createDocumentFragment();
            for (const ch of next) frag.appendChild(this.createChannelElement(ch));
            container.appendChild(frag);
            const newCount = currentCount + batch;
            if (newCount < filtered.length) this.addLoadMoreButton(container, filtered, newCount);
        }, { once:true });
        container.appendChild(wrap);
    }
}

// ===== EPG RENDERER =====
class EPGRenderer {
    constructor(timeManager) { this.timeManager = timeManager; }
    render(container, epgData) {
        if (!container) return;
        const programs = epgData?.programs;
        if (!programs?.length) { container.innerHTML = `<div class="no-results">${t('ui.нет')} ${t('ui.данных')} ${t('ui.о')} ${t('ui.программе')}</div>`; return; }

        const relevant = this.getRelevantPrograms(programs);
        const frag = document.createDocumentFragment();
        for (const p of relevant) frag.appendChild(this.createProgramElement(p));

        container.innerHTML = '<div class="epg-program-list"></div>';
        container.firstElementChild.appendChild(frag);
    }
    getRelevantPrograms(programs) {
        const now = Date.now();
        const list = [];
        let foundCurrent = false;
        for (const p of programs) {
            const st = this.timeManager.parseEPGTime(p.start);
            const et = this.timeManager.parseEPGTime(p.stop);
            if (et.getTime() < now) continue;
            const isCurrent = !foundCurrent && st.getTime() <= now && now < et.getTime();
            if (isCurrent) foundCurrent = true;
            list.push({ ...p, startTime: st, endTime: et, isCurrent });
            if (list.length >= 10) break;
        }
        return list;
    }
    createProgramElement(program) {
        const el = document.createElement('div');
        el.className = `epg-program-item ${program.isCurrent ? 'current-program' : ''}`;
        const timeStr = `${this.timeManager.formatTime(program.startTime)} - ${this.timeManager.formatTime(program.endTime)}`;
        const duration = Math.round((program.endTime - program.startTime) / 60000);
        el.innerHTML = `
            <div class="epg-program-time">${timeStr} <span class="duration">(${duration} мин)</span></div>
            <div class="epg-program-title">${program.title}</div>
            ${program.isCurrent ? `<div class="epg-current-badge">${t('ui.сейчас')}</div>` : ''}`;
        if (program.desc) el.title = program.desc;
        return el;
    }
}

// ===== PLAYER MANAGER =====
class PlayerManager extends EventEmitter {
    constructor(appState) {
        super();
        this.appState = appState;
        this.currentPlayer = null;
        this._devKeysHandler = null;
        this._ctxMenuHandler = null;
    }

    play(channel, epgData) {
        this.appState.set('currentChannel', { ...channel, epgData });
        this.emit('channelChanged', channel);
        this.updateActiveChannel(channel.url);
        this.initializePlayer(channel);
    }

    updateActiveChannel(url) {
        const items = document.querySelectorAll('.channel-item');
        for (const item of items) item.classList.toggle('active', item.dataset.url === url);
    }

    initializePlayer(channel) {
        const container = document.getElementById('player-container');
        if (!container) return;
        container.innerHTML = '<div id="player"></div>';

        if (this.currentPlayer) {
            try { this.currentPlayer.destroy?.(); } catch(e) { console.error('Player destroy failed:', e); }
            this.currentPlayer = null;
        }

        const perf = this.appState.get('devicePerformance');
        const isHLS = channel.url.includes('.m3u8');

        if (!window.VenomPlayer || !isHLS || perf === 'low') { this.createNativePlayer(container, channel); return; }
        this.createVenomPlayer(container, channel, perf);

        setTimeout(() => {
            const videoEl = this.getVideoElement();
            if (!this.recording) {
                const notifications = window.iptvApp?.components?.notifications;
                this.recording = new RecordingManager(this.appState, notifications);
            }
            this.recording.attachVideo(videoEl);
        }, 200);
    }

    createNativePlayer(container, channel) {
        const isHLS = channel.url.includes('.m3u8');
        const isMPD = channel.url.includes('.mpd');
        const mimeType = isHLS ? 'application/x-mpegURL' : isMPD ? 'application/dash+xml' : 'video/mp4';
        container.innerHTML = `
    <video controls autoplay
           style="width:100%;height:auto;background:#000;object-fit:contain;">
      <source src="${channel.url}" type="${mimeType}">
      Ваш браузер не поддерживает видео элемент.
    </video>`;
    }

    createVenomPlayer(container, channel, performance) {
        try {
            const bufferConfig = CONFIG.BUFFER_CONFIG[performance];
            this.currentPlayer = VenomPlayer.make({
                container: document.getElementById('player'),
                publicPath: './dist/',
                live: true,
                autoPlay: true,
                online: true,
                syncUser: true,
                blocked: false,
                theme: 'classic',
                aspectRatio: '16:9',
                title: channel.name,
                volume: localStorage.getItem('playerVolume') || 0.8,
                liveBuffer: 30,
                pip: true,
                mini: true,
                ui: {
                    prevNext: false,
                    share: false,
                    viewProgress: false,
                    progressBar: false,
                    timeline: false,
                    duration: false,
                    currentTime: true,
                    airplay: true,
                    pip: true,
                    mini: true,
                    about: false,
                    copyUrl: false,
                    copyWithTime: false,
                    fullscreen: true
                },
                source: {
                    hls: channel.url,
                    type: 'application/x-mpegURL',
                    audio: {
                        names: [`${t('ui.оригинал')}`, `${t('ui.русский')} ${t('ui.дубляж')}`, `${t('ui.русский')} ${t('ui.перевод')}`],
                        order: [0, 1, 2]
                    },
                    cc: [{
                        name: `${t('ui.русские')}`,
                        url: channel.subtitles?.ru
                    },
                        {
                            name: "English",
                            url: channel.subtitles?.en
                        }
                    ].filter(subtitle => subtitle.url)
                },
                hlsConfig: {
                    maxBufferLength: 15,              // Меньше буфер → меньше артефактов
                    maxMaxBufferLength: 30,
                    liveSyncDuration: 4,              // Увеличиваем, чтобы HLS не прыгал по битрейтам
                    liveMaxLatencyDuration: 12,
                    lowLatencyMode: false,            // ❗ Отключаем low latency — даёт лучшее качество
                    startLevel: -1,
                    capLevelToPlayerSize: false,      // ❗ Разрешаем брать поток выше размера плеера
                    maxAutoLevel: Number.MAX_VALUE,
                    manifestLoadingTimeOut: 10000,
                    manifestLoadingMaxRetry: 3,
                    levelLoadingTimeOut: 10000,
                    levelLoadingMaxRetry: 4,
                    enableWorker: true,
                    enableSoftwareAES: true,
                    maxBufferHole: 1.5,               // Чуть больше — меньше разрывов между кадрами
                    maxBufferSize: 120 * 1000 * 1000  // Дадим HLS больше свободы для FHD
                },
                text: {
                    settings: `${t('ui.настройки')}`,
                    quality: `${t('ui.качество')}`,
                    sound: `${t('ui.аудиодорожка')}`,
                    speed: `${t('ui.скорость')}`,
                    cc: `${t('ui.субтитры')}`,
                    online: `${t('ui.прямой')} ${t('ui.эфир')}`,
                    goLive: `${t('ui.online')}`,
                    play: `${t('ui.play')}`,
                    pause: `${t('ui.pause')}`,
                    mute: `${t('ui.отключить')} ${t('ui.звук')}`,
                    unMute: `${t('ui.включить')} ${t('ui.звук')}`,
                    fullscreenEnter: `${t('ui.полноэкранный')} ${t('ui.режим')}`,
                    fullscreenExit: `${t('ui.выход')} ${t('ui.из')} ${t('ui.полноэкранного')} ${t('ui.режима')}`,
                    pipIn: `${t('ui.картинка')} ${t('ui.в')} ${t('ui.картинке')}`,
                    pipOut: `${t('ui.выйти')} ${t('ui.из')} ${t('ui.режима')} ${t('ui.картинка')} ${t('ui.в')} ${t('ui.картинке')}`
                },
                format: {
                    quality: function(qualityData) {
                        let height;

                        if (typeof qualityData === 'number') {
                            height = qualityData;
                        } else if (qualityData && typeof qualityData === 'object') {
                            height = qualityData.height || qualityData.resolution || qualityData.quality || qualityData.level;
                        } else if (typeof qualityData === 'string') {
                            const match = qualityData.match(/(\d+)/);
                            height = match ? parseInt(match[1]) : null;
                        }

                        if (!height || isNaN(height)) {
                            return `${t('ui.авто')}`;
                        }

                        if (height >= 2160) return '4K ' + height + 'p';
                        if (height >= 1440) return '2K ' + height + 'p';
                        if (height >= 1080) return 'FullHD ' + height + 'p';
                        if (height >= 720) return 'HD ' + height + 'p';
                        if (height >= 480) return 'SD ' + height + 'p';
                        return height + 'p';
                    },
                },
                cssVars: {
                    'color-primary': '#ff4757',
                    'background-color-primary': 'rgba(0, 0, 0, 0.7)',
                    'color-live': '#ff4757',
                    'font-family': 'Arial, sans-serif'
                }
            });

            this.setupPlayerEventHandlers();
        } catch (error) {
            console.error('VenomPlayer initialization failed:', error);
            this.createNativePlayer(container, channel);
        }
    }

    setupPlayerEventHandlers() {
        if (!this.currentPlayer) return;

        this.currentPlayer.on('error', () => {
            setTimeout(() => { try { this.currentPlayer?.load?.(); } catch(e){ console.error('Player reload failed:', e); } }, 5000);
        });

        this.currentPlayer.on('ready', () => {
            if (this.currentPlayer.live) this.currentPlayer.seekToLive?.();
            const savedQuality = localStorage.getItem('preferredQuality');
            const savedAudio = localStorage.getItem('preferredAudio');
            try {
                if (savedQuality && this.currentPlayer.getQualityLevels) {
                    const levels = this.currentPlayer.getQualityLevels();
                    const target = levels.find(l => l.height == savedQuality);
                    if (target) this.currentPlayer.setCurrentLevel?.(target.level);
                }
                if (savedAudio && this.currentPlayer.setCurrentAudioTrack) {
                    this.currentPlayer.setCurrentAudioTrack(parseInt(savedAudio,10));
                }
            } catch(e) { console.error('Player preference restore error:', e); }
        });

        this.currentPlayer.on('qualitychange', (event) => {
            const q = event.level || event.quality;
            if (q?.height) localStorage.setItem('preferredQuality', q.height);
        });
        this.currentPlayer.on('audiochange', (audioTrack) => {
            try { localStorage.setItem('preferredAudio', audioTrack); } catch(_) {}
        });

        this.setupPlayerSecurity();
    }

    getVideoElement() {
        let v = document.querySelector('#player video');
        if (v) return v;
        v = document.querySelector('#player-container video');
        return v || null;
    }

    setupPlayerSecurity() {
        setTimeout(() => {
            const playerElement = document.getElementById('player');
            if (!playerElement) return;

            // Контекстное меню
            const ctxHandler = (e) => { e.preventDefault(); e.stopPropagation(); };
            playerElement.addEventListener('contextmenu', ctxHandler, { capture:true });
            this._ctxMenuHandler = { el: playerElement, fn: ctxHandler };

            // Скрытие брендинга
            this.hidePlayerBranding();

            // Блок `${t('ui.горячих')}` dev-клавиш
            const keysHandler = (e) => {
                if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J')) || (e.ctrlKey && e.key === 'u')) {
                    e.preventDefault(); e.stopPropagation();
                }
            };
            document.addEventListener('keydown', keysHandler, true);
            this._devKeysHandler = keysHandler;
        }, 300);
    }

    hidePlayerBranding() {
        let style = document.getElementById('venom-custom-hide');
        if (!style) {
            style = document.createElement('style');
            style.id = 'venom-custom-hide';
            document.head.appendChild(style);
        }
        style.textContent = `
            #player [class*="version"], #player .venom-version, #player .player-version,
            #player [data-action="copy"], #player [title*="Копировать"], #player .context-menu { display:none !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; }
            #player .live-indicator { background: var(--color-live, #ff4757) !important; animation: pulse 2s infinite !important; }
            @keyframes pulse { 0%{opacity:1}50%{opacity:.5}100%{opacity:1} }`;
    }

    destroy() {
        try { this.currentPlayer?.destroy?.(); } catch(e) { console.error('Player destroy error:', e); }
        this.currentPlayer = null;
        if (this._devKeysHandler) { document.removeEventListener('keydown', this._devKeysHandler, true); this._devKeysHandler = null; }
        if (this._ctxMenuHandler) { this._ctxMenuHandler.el.removeEventListener('contextmenu', this._ctxMenuHandler.fn, true); this._ctxMenuHandler = null; }
        const style = document.getElementById('venom-custom-hide');
        if (style) style.remove();
        try { this.recording?.destroy?.(); } catch(_) {}
        this.recording = null;
    }
}

// ===== RECORDING MANAGER =====
class RecordingManager extends EventEmitter {
    constructor(appState, notifications) {
        super();
        this.appState = appState;
        this.notifications = notifications;
        this.video = null;
        this.mediaStream = null;
        this.mediaRecorder = null;
        this.mimeType = null;

        this.isActive = false;
        this.segmentMinutes = CONFIG.RECORDING.defaultSegmentMinutes;
        this.segmentMs = this.segmentMinutes * 60 * 1000;

        this._chunks = [];
        this._segIndex = 1;
        this._segmentTimer = null;
        this._startedAt = null;

        // Ручной режим: без авто-сегментации, пользователь сам жмёт «старт/стоп»
        this.manualMode = false;
        this._safetyStopTimer = null; // предохранитель по максимальной длительности

        // для канваса (захват видео с сохранением 16:9)
        this._rafId = null;
        this._stopCanvasPipe = null;
    }

    attachVideo(videoEl) {
        this.video = videoEl || null;
    }

    setSegmentMinutes(min) {
        const m = Number(min) || CONFIG.RECORDING.defaultSegmentMinutes;
        this.segmentMinutes = Math.max(1, Math.min(180, m));
        this.segmentMs = this.segmentMinutes * 60 * 1000;
        // при ручном режиме таймер не перезапускаем
        if (this.isActive && !this.manualMode) this._restartSegmentTimer();
    }

    setManualMode(on) {
        const next = !!on;
        if (this.manualMode === next) return;
        this.manualMode = next;

        if (this.isActive) {
            // переключение «на лету»
            this._clearSegmentTimer();
            this._clearSafetyStopTimer();
            if (this.manualMode) {
                this._startSafetyStopTimer();
                this.notifications?.show(`${t('ui.режим')} ${t('ui.записи')}`, `${t('ui.ручной')}: ${t('ui.сегментации')} ${t('ui.нет')}`, 'info');
            } else {
                this._startSegmentTimer();
                this.notifications?.show(`${t('ui.режим')} ${t('ui.записи')}`, `Авто: сегменты по ${this.segmentMinutes} мин.`, 'info');
            }
        }
    }

    _pickMimeType() {
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        if (isSafari) {
            const mp4 = 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"';
            if (MediaRecorder.isTypeSupported(mp4)) return mp4; // H.264 + AAC
        }
        const prefs = [
            'video/mp4;codecs="h264,aac"',
            'video/mp4;codecs="h265,aac"',
            'video/mp4;codecs="hev1,aac"',
            'video/mp4'
        ];
        for (const cand of prefs) {
            try { if (MediaRecorder.isTypeSupported(cand)) return cand; } catch(_) {}
        }
        return '';
    }

    _getVideoTitle() {
        const ch = this.appState.get('currentChannel');
        return (ch?.name || 'Live').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
    }

    _mkFileName(extension) {
        const now = new Date();
        const pad = (n)=> String(n).padStart(2,'0');
        const date = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
        const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        const title = this._getVideoTitle();
        // если ручной режим — без сегмента; иначе _partXX
        const seg = this.manualMode ? '' : `_${'part' + String(this._segIndex).padStart(2,'0')}`;

        const base = CONFIG.RECORDING.fileNameTemplate
            .replace('{date}', date)
            .replace('{time}', time)
            .replace('{title}', title)
            .replace('{seg}', seg);
        return base + extension;
    }

    _captureStream() {
        if (!this.video) throw new Error(`${t('ui.видео')} ${t('ui.элемент')} ${t('ui.не')} ${t('ui.найден')}`);

        // Канвас фиксированного 16:9 (с сохранением пропорций картинки внутри)
        const W = 1280, H = 720;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');

        const draw = () => {
            const vw = this.video.videoWidth || 16, vh = this.video.videoHeight || 9;
            const vr = vw / vh, cr = W / H;
            let dw, dh, dx, dy;
            if (vr > cr) {
                dw = W; dh = W / vr; dx = 0; dy = (H - dh) / 2;
            } else {
                dh = H; dw = H * vr; dy = 0; dx = (W - dw) / 2;
            }
            ctx.fillStyle = '#000'; ctx.fillRect(0,0,W,H);
            try { ctx.drawImage(this.video, dx, dy, dw, dh); } catch(_) {}
            this._rafId = requestAnimationFrame(draw);
        };
        this._rafId = requestAnimationFrame(draw);

        // Видео из канваса
        const canvasStream = canvas.captureStream(30);

        // Аудио из <video>
        const vs = this.video.captureStream?.() || this.video.mozCaptureStream?.();
        const audioTrack = vs?.getAudioTracks?.()[0];

        const out = new MediaStream([
            ...canvasStream.getVideoTracks(),
            ...(audioTrack ? [audioTrack] : [])
        ]);

        this._stopCanvasPipe = () => {
            try { cancelAnimationFrame(this._rafId); } catch(_) {}
            this._rafId = null;
            try { canvasStream.getTracks().forEach(t => t.stop()); } catch(_) {}
        };

        return out;
    }

    async start() {
        if (!CONFIG.RECORDING.enabled) throw new Error(`${t('ui.запись')} ${t('ui.выключена')} ${t('ui.конфигурацией')}`);
        if (this.isActive) return;

        // Блокируем Safari: запись недоступна
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        if (isSafari) {
            throw new Error(`${t('ui.для')} ${t('ui.записи')} ${t('ui.воспользуйтесь')} ${t('ui.другим')} ${t('ui.браузером')}`);
        }

        this.mimeType = this._pickMimeType();
        if (!this.mimeType) throw new Error(`MediaRecorder ${t('ui.неподдерживаем')}: ${t('ui.нет')} ${t('ui.подходящего')} MIME (mp4/webm)`);

        this.mediaStream = this._captureStream();
        this.mediaRecorder = new MediaRecorder(this.mediaStream, {
            mimeType: this.mimeType,
            videoBitsPerSecond: 6_000_000
        });

        this._chunks = [];
        this._segIndex = 1;
        this._startedAt = Date.now();

        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) this._chunks.push(e.data);
        };

        this.mediaRecorder.onerror = (e) => {
            this.notifications?.show(`${t('ui.ошибка')} ${t('ui.записи')}`, e.error?.message || `${t('ui.неизвестная')} ${t('ui.ошибка')}`, 'error');
            this.stop(false);
        };

        this.mediaRecorder.onstop = () => {
            // даём последнему dataavailable долететь
            setTimeout(() => {
                if (this._chunks.length) {
                    const ext = this.mimeType.includes('mp4') ? 'mp4' : 'webm';
                    const blob = new Blob(this._chunks, { type: this.mimeType });
                    this._saveBlob(blob, this._mkFileName(ext));
                    this._chunks = [];
                    this._segIndex++;
                } else {
                    console.warn('Recorder stopped but no data chunks were received.');
                }
            }, 50);
        };

        this.mediaRecorder.start();
        this.isActive = true;

        if (this.manualMode) this._startSafetyStopTimer();
        else this._startSegmentTimer();

        const fmt = this.mimeType.includes('mp4') ? 'MP4' : 'WebM';
        const mode = this.manualMode ? `${t('ui.ручной')}` : `Авто (${this.segmentMinutes} мин)`;
        this.notifications?.show(`${t('ui.запись')} ${t('ui.начата')}`, `Формат: ${fmt}. Режим: ${mode}.`, 'success');
    }

    _startSegmentTimer() {
        this._clearSegmentTimer();
        this._segmentTimer = setInterval(() => {
            if (Date.now() - this._startedAt > CONFIG.RECORDING.maxHoursPerFile * 3600e3) {
                this.notifications?.show(`${t('ui.запись')} ${t('ui.остановлена')}`, `${t('ui.достигнут')} ${t('ui.лимит')} ${t('ui.длительности')}`, 'info');
                this.stop(true);
                return;
            }
            if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                this.mediaRecorder.requestData();
                this.mediaRecorder.stop();
                const prevMime = this.mimeType;
                const stream = this.mediaStream;

                setTimeout(() => {
                    if (!this.isActive || this.manualMode) return; // если переключили на ручной
                    this._chunks = [];
                    try {
                        this.mediaRecorder = new MediaRecorder(stream, { mimeType: prevMime, videoBitsPerSecond: 6_000_000 });
                        this.mediaRecorder.ondataavailable = (e)=>{ if (e.data && e.data.size) this._chunks.push(e.data); };
                        this.mediaRecorder.onerror = (e)=>{ this.notifications?.show(`${t('ui.ошибка')} ${t('ui.записи')}`, e.error?.message || `${t('ui.неизвестная')} ${t('ui.ошибка')}`, 'error'); this.stop(false); };
                        this.mediaRecorder.onstop = () => {
                            if (this._chunks.length) {
                                const ext = prevMime.includes('mp4') ? 'mp4' : 'webm';
                                const blob = new Blob(this._chunks, { type: prevMime });
                                this._saveBlob(blob, this._mkFileName(ext));
                                this._chunks = [];
                                this._segIndex++;
                            }
                        };
                        this.mediaRecorder.start();
                    } catch (err) {
                        this.notifications?.show(`${t('ui.ошибка')} ${t('ui.записи')}`, err.message, 'error');
                        this.stop(false);
                    }
                }, 20);
            }
        }, this.segmentMs);
    }

    _startSafetyStopTimer() {
        this._clearSafetyStopTimer();
        const maxMs = CONFIG.RECORDING.maxHoursPerFile * 3600e3;
        // Проверяем каждые 5 секунд, чтобы не держать частые таймеры
        this._safetyStopTimer = setInterval(() => {
            if (!this.isActive) return;
            if (Date.now() - this._startedAt > maxMs) {
                this.notifications?.show(`${t('ui.запись')} ${t('ui.остановлена')}`, `${t('ui.достигнут')} ${t('ui.лимит')} ${t('ui.длительности')}`, 'info');
                this.stop(true);
            }
        }, 5000);
    }

    _restartSegmentTimer() {
        if (!this.isActive || this.manualMode) return;
        this._clearSegmentTimer();
        this._startSegmentTimer();
    }

    _clearSegmentTimer() {
        if (this._segmentTimer) { clearInterval(this._segmentTimer); this._segmentTimer = null; }
    }

    _clearSafetyStopTimer() {
        if (this._safetyStopTimer) { clearInterval(this._safetyStopTimer); this._safetyStopTimer = null; }
    }

    _saveBlob(blob, fileName) {
        try {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            this.emit('segmentSaved', { fileName, size: blob.size });
            this.notifications?.show(`${t('ui.сегмент')} ${t('ui.сохранен')}`, fileName, 'success');
        } catch (e) {
            console.error('Save blob failed:', e);
            this.notifications?.show(`${t('ui.ошибка')} ${t('ui.сохранения')}`, e.message, 'error');
        }
    }

    stop(saveLast = true) {
        this._clearSegmentTimer();
        this._clearSafetyStopTimer();

        if (this.mediaRecorder) {
            if (this.mediaRecorder.state === 'recording') {
                if (saveLast) this.mediaRecorder.requestData();
                try { this.mediaRecorder.stop(); } catch(_) {}
            }
            this.mediaRecorder = null;
        }

        if (this.mediaStream) {
            try { this.mediaStream.getTracks().forEach(t => t.stop?.()); } catch(_) {}
            this.mediaStream = null;
        }

        try { this._stopCanvasPipe?.(); } catch(_) {}
        this._stopCanvasPipe = null;

        this.isActive = false;
        this._chunks = [];
        this.emit('stopped');
        this.notifications?.show(`${t('ui.запись')} ${t('ui.остановлена')}`, this.manualMode ? `${t('ui.ручной')} ${t('ui.режим')}` : '', 'info');
    }

    destroy() {
        this.stop(false);
        this.video = null;
    }
}

// ===== MAIN APPLICATION =====
class IPTVApp {
    constructor() {
        this.components = {};
        this.eventUnsubscribers = [];
        this._domListeners = [];
        this._boundBeforeUnload = null;
    }

    async init() {
        try {
            this.components.appState = new AppState();
            this.components.database = new DatabaseManager();
            this.components.notifications = new NotificationManager();
            this.components.timeManager = new TimeManager();

            await this.components.database.init();
            this.components.appState.set('db', this.components.database);

            this.components.epgManager = new EPGManager(this.components.database, this.components.timeManager);
            this.components.playlistManager = new PlaylistManager(this.components.database);
            this.components.playerManager = new PlayerManager(this.components.appState);

            this.components.channelRenderer = new ChannelRenderer(this.components.epgManager, this.components.appState);
            this.components.epgRenderer = new EPGRenderer(this.components.timeManager);

            this.setupEventListeners();
            this.setupUI();
            await this.loadInitialData();

        } catch (error) {
            console.error('Failed to initialize IPTV App:', error);
            this.components.notifications?.show(`${t('ui.ошибка')} ${t('ui.инициализации')}`, error.message, 'error');
        }
    }

    // Хелпер для DOM listeners с авто-снятием
    on(el, event, handler, options) {
        el.addEventListener(event, handler, options);
        this._domListeners.push([el, event, handler, options]);
    }

    setupEventListeners() {
        const { appState, epgManager, playlistManager, playerManager, notifications } = this.components;

        // Функция для безопасного получения перевода
        const t = (key, fallback) => {
            if (window.I18N_AJAX?.t) {
                return window.I18N_AJAX.t(key, fallback || key);
            }
            return fallback || key;
        };

        // Обновлять локализованный текст фильтра при смене языка
        try {
            document.addEventListener('i18n:lang-changed', () => {
                const groups = this.components.appState.get('groups') || [];
                this.updateGroupFilter(groups);
            });
        } catch(e) {
            console.warn('i18n listener failed', e);
        }

        this.subscribe(playlistManager, 'loaded', ({ channels, groups }) => {
            appState.clearCaches();
            appState.update({ channels, groups, searchQuery: '', selectedGroup: '' });
            this.updateGroupFilter(groups);
            this.resetFilters();
            this.renderChannels();

            // Исправлено: правильный перевод для уведомления
            const title = `${t('ui.плейлист')} ${t('ui.загружен')}`;
            const message = `${t('ui.загружено')} ${channels.length} ${t('ui.каналов')}`;
            notifications.show(title, message, 'success');

            epgManager.load().catch(() => {});
        });

        this.subscribe(epgManager, 'loaded', (epgData) => {
            appState.set('epgData', epgData);
            this.renderChannels();
            epgManager.startUpdates();
            const count = Object.keys(epgData).length;

            // Исправлено: полный перевод уведомления
            const title = `${t('ui.программа')} ${t('ui.передач')} ${t('ui.загружена')}`;
            const message = `${t('ui.для')} ${count} ${t('ui.каналов')}`;
            notifications.show(title, message, 'success');
        });

        this.subscribe(epgManager, 'offline', (message) => {
            notifications.show(`${t('ui.программа')} ${t('ui.передач')}`, message, 'info');
        });

        this.subscribe(epgManager, 'update', () => {
            epgManager.programCache.clear();
            this.updateVisibleChannelPrograms();
            const current = appState.get('currentChannel');
            if (current?.epgData) {
                const fresh = epgManager.findMatchingChannel(current.name);
                this.renderEPG(fresh);
            }
        });

        this.subscribe(appState, 'channelSelected', ({ channel }) => {
            const fresh = epgManager.findMatchingChannel(channel.name);

            // Auto-stop recording on channel change only if active
            try {
                const recObj = this.components.playerManager.recording;
                if (recObj?.isActive) {
                    recObj.stop(true);
                    const rs = document.getElementById('record-start');
                    const rstop = document.getElementById('record-stop');
                    if (rs) { rs.classList.remove('recording-active'); rs.setAttribute('aria-pressed','false'); }
                    if (rstop) rstop.disabled = true;
                }
            } catch (_) {}

            playerManager.play(channel, fresh);
            this.renderEPG(fresh);
        });

        this.subscribe(epgManager, 'error', (error) => {
            console.error('EPG error:', error);
            notifications.show(`${t('ui.ошибка')} EPG`, error.message, 'error');
        });

        this.subscribe(playlistManager, 'error', (error) => {
            console.error('Playlist error:', error);
            notifications.show(`${t('ui.ошибка')} ${t('ui.плейлиста')}`, error.message, 'error');
        });
    }

    resetFilters() {
        const searchInput = document.getElementById('search');
        const groupFilter = document.getElementById('group-filter');
        const clearButton = document.querySelector('.search-clear');
        if (searchInput) searchInput.value = '';
        if (groupFilter) groupFilter.value = '';
        if (clearButton) clearButton.style.display = 'none';
    }

    subscribe(emitter, event, handler) {
        const unsubscribe = emitter.on(event, handler);
        this.eventUnsubscribers.push(unsubscribe);
        return unsubscribe;
    }

    setupUI() {
        this.displayTimezone();
        this.setupDialogs();
        this.setupControls();
    }

    displayTimezone() {
        const el = document.getElementById('timezone-display');
        if (el) el.innerHTML = this.components.timeManager.getTimezoneDisplay();
    }

    setupDialogs() { this.setupPlaylistDialog(); this.setupEpgDialog(); }

    setupPlaylistDialog() {
        const dialog = document.getElementById('playlist-dialog');
        if (!dialog) return;
        const closeDialog = () => dialog.classList.remove('active');

        const closeBtn = dialog.querySelector('.dialog-close');
        if (closeBtn) this.on(closeBtn, 'click', closeDialog);
        const cancelBtn = document.getElementById('cancel-load-btn');
        if (cancelBtn) this.on(cancelBtn, 'click', closeDialog);

        dialog.querySelectorAll('.dialog-tab').forEach(tab => {
            this.on(tab, 'click', () => {
                document.querySelectorAll('.dialog-content').forEach(c => c.classList.remove('active'));
                const content = document.getElementById(tab.dataset.tab);
                if (content) content.classList.add('active');

                dialog.querySelectorAll('.dialog-tab').forEach(t => {
                    const active = t === tab;
                    t.classList.toggle('active', active);
                    t.setAttribute('aria-selected', active);
                });
            });
        });

        const fileInput = document.getElementById('playlist-file');
        const loadFileBtn = document.getElementById('load-file-btn');
        const fileNameDisplay = document.getElementById('file-name');
        if (fileInput && loadFileBtn && fileNameDisplay) {
            this.on(fileInput, 'change', function() {
                if (this.files?.length > 0) { fileNameDisplay.textContent = this.files[0].name; loadFileBtn.disabled = false; }
                else { fileNameDisplay.textContent = `${t('ui.файл')} ${t('ui.не')} ${t('ui.выбран')}`; loadFileBtn.disabled = true; }
            });
            this.on(loadFileBtn, 'click', async () => {
                if (!fileInput.files?.length) return;
                const file = fileInput.files[0];
                const statusEl = document.getElementById('file-status');
                if (statusEl) { statusEl.textContent = `${t('ui.загрузка')}...`; statusEl.className = 'status-message'; }
                try {
                    loadFileBtn.disabled = true;
                    await this.components.playlistManager.loadFromFile(file);
                    if (statusEl) { statusEl.textContent = `${t('ui.плейлист')} ${t('ui.успешно')} ${t('ui.загружен')}`; statusEl.className = 'status-message status-success'; }
                    setTimeout(closeDialog, 1200);
                } catch (error) {
                    if (statusEl) { statusEl.textContent = `${t('ui.ошибка')}: ` + error.message; statusEl.className = 'status-message status-error'; }
                } finally {
                    loadFileBtn.disabled = false;
                }
            });
        }

        const urlInput = document.getElementById('playlist-url');
        const loadUrlBtn = document.getElementById('load-url-btn');
        if (urlInput && loadUrlBtn) {
            this.on(loadUrlBtn, 'click', async () => {
                const url = urlInput.value.trim();
                const statusEl = document.getElementById('url-status');
                if (!url) {
                    if (statusEl) { statusEl.textContent = `${t('ui.введите')} URL ${t('ui.плейлиста')}`; statusEl.className = 'status-message status-error'; }
                    return;
                }
                if (statusEl) { statusEl.textContent = `${t('ui.загрузка')}...`; statusEl.className = 'status-message'; }
                try {
                    loadUrlBtn.disabled = true;
                    await this.components.playlistManager.loadFromUrl(url);
                    if (statusEl) { statusEl.textContent = `${t('ui.плейлист')} ${t('ui.успешно')} ${t('ui.загружен')}`; statusEl.className = 'status-message status-success'; }
                    setTimeout(closeDialog, 1200);
                } catch (error) {
                    if (statusEl) { statusEl.textContent = `${t('ui.ошибка')}: ` + error.message; statusEl.className = 'status-message status-error'; }
                } finally {
                    loadUrlBtn.disabled = false;
                }
            });
        }

        const loadDefaultBtn = document.getElementById('load-default-btn');
        if (loadDefaultBtn) {
            this.on(loadDefaultBtn, 'click', async () => {
                const statusEl = document.getElementById('demo-status');
                if (statusEl) { statusEl.textContent = `${t('ui.загрузка')} ${t('ui.демо')}-${t('ui.плейлиста')}...`; statusEl.className = 'status-message'; }
                try {
                    loadDefaultBtn.disabled = true;
                    await this.components.playlistManager.loadFromUrl(CONFIG.DEFAULT_PLAYLIST_URL);
                    if (statusEl) { statusEl.textContent = `${t('ui.демо')}-${t('ui.плейлист')} ${t('ui.успешно')} ${t('ui.загружен')}`; statusEl.className = 'status-message status-success'; }
                    setTimeout(closeDialog, 1200);
                } catch (error) {
                    if (statusEl) { statusEl.textContent = `${t('ui.ошибка')}: ` + error.message; statusEl.className = 'status-message status-error'; }
                } finally {
                    loadDefaultBtn.disabled = false;
                }
            });
        }

        this.showPlaylistDialog = () => dialog.classList.add('active');
    }

    setupEpgDialog() {
        const dialog = document.getElementById('epg-dialog');
        if (!dialog) return;
        const closeDialog = () => dialog.classList.remove('active');

        const closeBtn = dialog.querySelector('.dialog-close');
        if (closeBtn) this.on(closeBtn, 'click', closeDialog);
        const cancelBtn = document.getElementById('cancel-epg-btn');
        if (cancelBtn) this.on(cancelBtn, 'click', closeDialog);

        const refreshBtn = document.getElementById('refresh-epg-btn');
        if (refreshBtn) {
            this.on(refreshBtn, 'click', async () => {
                const statusEl = document.getElementById('epg-status');
                if (statusEl) { statusEl.textContent = `${t('ui.обновление')} EPG...`; statusEl.className = 'status-message'; }
                try {
                    refreshBtn.disabled = true;
                    await this.components.epgManager.refresh();
                    if (statusEl) { statusEl.textContent = `EPG ${t('ui.успешно')} ${t('ui.обновлен')}`; statusEl.className = 'status-message status-success'; }
                    this.renderChannels();
                    setTimeout(closeDialog, 1200);
                } catch (error) {
                    if (statusEl) { statusEl.textContent = `${t('ui.ошибка')}: ` + error.message; statusEl.className = 'status-message status-error'; }
                } finally {
                    refreshBtn.disabled = false;
                }
            });
        }
        this.showEpgDialog = () => dialog.classList.add('active');
    }

    setupControls() {
        const searchInput = document.getElementById('search');
        const clearButton = document.querySelector('.search-clear');
        const groupFilter = document.getElementById('group-filter');

        if (searchInput) {
            const debounced = this.debounce((value) => {
                this.components.appState.set('searchQuery', value);
                this.renderChannels();
                if (clearButton) clearButton.style.display = value ? 'flex' : 'none';
            }, CONFIG.SEARCH_DEBOUNCE_DELAY);
            this.on(searchInput, 'input', (e) => debounced(e.target.value));
        }

        if (clearButton) {
            this.on(clearButton, 'click', () => {
                if (searchInput) { searchInput.value = ''; searchInput.focus(); }
                clearButton.style.display = 'none';
                this.components.appState.set('searchQuery', '');
                this.renderChannels();
            });
        }

        if (groupFilter) {
            this.on(groupFilter, 'change', (e) => {
                this.components.appState.set('selectedGroup', e.target.value);
                this.renderChannels();
            });
        }

        const refreshEpgBtn = document.getElementById('refresh-epg');
        if (refreshEpgBtn) this.on(refreshEpgBtn, 'click', () => this.showEpgDialog());
        const loadNewBtn = document.getElementById('load-new-playlist');
        if (loadNewBtn) this.on(loadNewBtn, 'click', () => this.showPlaylistDialog());

        const recStart = document.getElementById('record-start');
        const recStop  = document.getElementById('record-stop');
        const recSeg   = document.getElementById('record-segment');

        // --- Recording UI helpers (как у вас) ---
        let __recUI = false;
        const setRecordingUI = (on) => {
            __recUI = !!on;
            try {
                const btnStart = document.getElementById('record-start');
                const btnStop  = document.getElementById('record-stop');
                btnStart && btnStart.classList.toggle('recording-active', __recUI);
                btnStart && btnStart.setAttribute('aria-pressed', __recUI ? 'true' : 'false');
                if (btnStop) btnStop.disabled = !__recUI;
            } catch (_) {}
        };
        setRecordingUI(false);

        if (recSeg) {
            this.on(recSeg, 'change', (e) => {
                const val = e.target.value;
                const rec = this.components.playerManager?.recording;
                if (!rec) return;

                if (val === 'manual') {
                    rec.setManualMode(true);
                    this.components.notifications?.show(`${t('ui.режим')} ${t('ui.записи')}`, `${t('ui.ручной')} (${t('ui.без')} ${t('ui.сегментации')})`, 'info');
                } else {
                    const m = parseInt(val, 10);
                    rec.setManualMode(false);
                    rec.setSegmentMinutes(m);
                    this.components.notifications?.show(`${t('ui.сегментация')}`, `Новый размер: ${m} мин.`, 'info');
                }
            });
        }

        if (recStart) {
            this.on(recStart, 'click', async () => {
                try {
                    const videoEl = this.components.playerManager.getVideoElement();
                    if (!videoEl) throw new Error(`${t('ui.видео')} ${t('ui.поток')} ${t('ui.не')} ${t('ui.найден')}. ${t('ui.сначала')} ${t('ui.запустите')} ${t('ui.канал')}.`);

                    if (!this.components.playerManager.recording) {
                        this.components.playerManager.recording =
                            new RecordingManager(this.components.appState, this.components.notifications);

                        this.components.playerManager.recording.on('stopped', () => setRecordingUI(false));
                        this.components.playerManager.recording.on('tick', ({ elapsedMs }) => {
                            if (recTimer) recTimer.textContent = fmt(elapsedMs);
                        });
                    }

                    const rec = this.components.playerManager.recording;
                    rec.attachVideo(videoEl);

                    // Применяем выбранный режим из селекта перед стартом
                    const segVal = recSeg?.value;
                    if (segVal === 'manual') {
                        rec.setManualMode(true);
                    } else if (segVal) {
                        rec.setManualMode(false);
                        rec.setSegmentMinutes(parseInt(segVal, 10));
                    }

                    await rec.start(); // <-- тут выбросится ошибка в Safari
                    setRecordingUI(true);
                } catch (err) {
                    this.components.notifications?.show(`${t('ui.запись')} ${t('ui.не')} ${t('ui.запущена')}`, err.message, 'error');
                }
            });
        }

        if (recStop) {
            this.on(recStop, 'click', () => {
                try {
                    this.components.playerManager.recording?.stop(true);
                } catch (err) {
                    this.components.notifications?.show(`${t('ui.ошибка')} ${t('ui.остановки')}`, err.message, 'error');
                }
                setRecordingUI(false);
            });
        }
    }

    async loadInitialData() {
        try {
            const playlists = await this.components.database.getAll('playlists');
            if (playlists?.length > 0) {
                const playlist = playlists[0];
                this.components.appState.set('currentPlaylistUrl', playlist.url);
                this.components.playlistManager.parseM3U8(playlist.data);
                const { channels, groups } = this.components.playlistManager;
                this.components.appState.update({ channels, groups });
                this.updateGroupFilter(groups);
                await this.components.epgManager.load();
                this.renderChannels();
            } else {
                this.showPlaylistDialog();
            }
        } catch (error) {
            console.error('Failed to load initial data:', error);
            this.components.notifications.show(`${t('ui.ошибка')} ${t('ui.загрузки')}`, `${t('ui.не')} ${t('ui.удалось')} ${t('ui.загрузить')} ${t('ui.данные')}`, 'error');
            this.showPlaylistDialog();
        }
    }

    renderChannels() {
        const container = document.getElementById('channels-list');
        if (!container) return;
        const { appState, channelRenderer } = this.components;
        const channels = appState.get('channels') || [];
        const searchQuery = appState.get('searchQuery') || '';
        const selectedGroup = appState.get('selectedGroup') || '';
        const filtered = channelRenderer.renderChannels(container, channels, searchQuery, selectedGroup);
        appState.set('filteredChannels', filtered);
    }

    renderEPG(epgData) {
        const container = document.getElementById('epg-container');
        if (container) this.components.epgRenderer.render(container, epgData);
    }

    updateGroupFilter(groups) {
        const filter = document.getElementById('group-filter');
        if (!filter) return;
        const currentValue = filter.value;
        const isValid = currentValue === '' || groups.includes(currentValue);
        filter.innerHTML = `<option value="" data-i18n="ui.все_группы"></option>`;
        if (window.I18N_AJAX) I18N_AJAX.apply(filter);
        const frag = document.createDocumentFragment();
        for (const g of groups) {
            const opt = document.createElement('option');
            opt.value = g; opt.textContent = g;
            frag.appendChild(opt);
        }
        filter.appendChild(frag);
        filter.value = isValid ? currentValue : '';
        if (!isValid) this.components.appState.set('selectedGroup', '');
    }

    updateVisibleChannelPrograms() {
        const items = document.querySelectorAll('.channel-item');
        const { epgManager } = this.components;
        const channels = this.components.appState.get('filteredChannels') || [];
        // Быстрая карта URL -> канал
        const map = new Map(channels.map(c => [c.url, c]));
        for (const item of items) {
            const url = item.dataset.url;
            const channel = map.get(url);
            if (!channel) continue;
            const epgData = epgManager.findMatchingChannel(channel.name);
            const currentProgram = epgManager.getCurrentProgram(channel.name, epgData);
            const progressBar = epgManager.getProgressBar(epgData);
            const programElement = item.querySelector('.channel-program');
            if (programElement) { programElement.textContent = currentProgram; programElement.title = currentProgram; }
            const existing = item.querySelector('.channel-progress-container');
            if (existing) existing.remove();
            if (progressBar) {
                const info = item.querySelector('.channel-info');
                if (info) info.insertAdjacentHTML('beforeend', progressBar);
            }
        }
    }

    debounce(func, wait) {
        let timeout = null;
        return (...args) => {
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => { timeout = null; func(...args); }, wait);
        };
    }

    destroy() {
        this.eventUnsubscribers.forEach(unsub => { try { unsub(); } catch(_){} });
        this.eventUnsubscribers = [];
        for (const [el, evt, fn, opt] of this._domListeners) {
            try { el.removeEventListener(evt, fn, opt); } catch(_) {}
        }
        this._domListeners = [];
        Object.values(this.components).forEach(c => { try { c?.destroy?.(); } catch(_){} });
    }
}


// ===== INITIALIZATION =====
document.addEventListener('DOMContentLoaded', async () => {
    try {
        window.iptvApp = new IPTVApp();
        await window.iptvApp.init();
    } catch (e) {
        console.error('App bootstrap error:', e);
    }
}, { once: true });

window.addEventListener('beforeunload', () => { try { window.iptvApp?.destroy?.(); } catch(_){} }, { once:true });
