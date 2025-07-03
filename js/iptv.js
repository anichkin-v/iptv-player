// ===== CONFIGURATION & CONSTANTS =====
const CONFIG = Object.freeze({
    DB_NAME: 'IPTVDB2',
    DB_VERSION: 4,
    M3U8_EXPIRY: 365 * 24 * 60 * 60 * 1000,
    EPG_EXPIRY: 6 * 60 * 60 * 1000,
    EPG_TIMEZONE_OFFSET: 3,
    EPG_URL: 'http://iptv.apiweb.uz/epg.xml',
    DEFAULT_PLAYLIST_URL: 'http://iptv.apiweb.uz/playlist.php?default=1',
    CHANNELS_PER_PAGE: 3500,
    EPG_UPDATE_INTERVAL: 30000,
    SEARCH_DEBOUNCE_DELAY: 200,
    MAX_CACHE_SIZE: 600,
    NOTIFICATION_DURATION: 10000,
    BATCH_SIZE: {
        low: 200,
        medium: 500,
        high: 3500
    },
    BUFFER_CONFIG: {
        low: { maxBufferLength: 60, maxBufferSize: 5 * 1024 * 1024 },
        medium: { maxBufferLength: 180, maxBufferSize: 10 * 1024 * 1024 },
        high: { maxBufferLength: 420, maxBufferSize: 20 * 1024 * 1024 }
    }
});

// ===== UTILITY CLASSES =====
class EventEmitter {
    constructor() {
        this.events = new Map();
    }

    on(event, callback) {
        if (!this.events.has(event)) {
            this.events.set(event, new Set());
        }
        this.events.get(event).add(callback);
        return () => this.events.get(event)?.delete(callback);
    }

    emit(event, ...args) {
        const handlers = this.events.get(event);
        if (handlers) {
            handlers.forEach(callback => {
                try {
                    callback(...args);
                } catch (error) {
                    console.error('Event handler error:', error);
                }
            });
        }
    }

    destroy() {
        this.events.clear();
    }
}

class Cache extends Map {
    constructor(maxSize = CONFIG.MAX_CACHE_SIZE) {
        super();
        this.maxSize = maxSize;
    }

    set(key, value) {
        if (this.size >= this.maxSize) {
            const firstKey = this.keys().next().value;
            this.delete(firstKey);
        }
        super.set(key, value);
        return this;
    }

    setWithTTL(key, value, ttl) {
        this.set(key, { value, expiry: Date.now() + ttl });
    }

    get(key) {
        const item = super.get(key);
        if (item?.expiry && Date.now() > item.expiry) {
            this.delete(key);
            return undefined;
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

        if (memory <= 2 || cores <= 2) {
            this._level = 'low';
        } else if (memory >= 8 && cores >= 4) {
            this._level = 'high';
        } else {
            this._level = 'medium';
        }

        return this._level;
    }
}

// ===== CHANNEL NAME NORMALIZER =====
class ChannelNameNormalizer {
    static normalizeChannelName(name) {
        if (!name || typeof name !== 'string') return '';

        return name
            .replace(/\([^)]*\)/g, '')
            .replace(/\+\d+\s*/g, '')
            .replace(/\b(HD|FHD|UHD|4K|SD)\b/gi, '')
            .replace(/[^\wа-яё\s]/gi, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    static extractKeywords(name) {
        const normalized = this.normalizeChannelName(name);
        return normalized.split(/\s+/).filter(word => word.length > 1);
    }

    static getChannelVariants(name) {
        const variants = new Set();
        const original = name.toLowerCase().trim();
        variants.add(original);

        const normalized = this.normalizeChannelName(name);
        if (normalized) variants.add(normalized);

        const withoutNumbers = normalized.replace(/\d+/g, '').trim();
        if (withoutNumbers) variants.add(withoutNumbers);

        const mainWord = normalized.split(/\s+/)[0];
        if (mainWord && mainWord.length > 2) variants.add(mainWord);

        return Array.from(variants).filter(v => v.length > 0);
    }
}

// ===== STREAM FORMAT DETECTOR =====
class StreamFormatDetector {
    static detectFormat(url) {
        if (!url) return { type: 'mp4', mimeType: 'video/mp4', isLive: false };

        const cleanUrl = url.split('?')[0].toLowerCase();
        const protocol = url.split(':')[0].toLowerCase();

        if (protocol === 'rtmp' || protocol === 'rtmps') {
            return { type: 'rtmp', mimeType: 'video/mp4', isLive: true, unsupported: true };
        }

        if (protocol === 'rtsp' || protocol === 'rtsps') {
            return { type: 'rtsp', mimeType: 'video/mp4', isLive: true, unsupported: true };
        }

        if (cleanUrl.includes('.m3u8') || cleanUrl.includes('.m3u')) {
            return { type: 'hls', mimeType: 'application/x-mpegURL', isLive: true };
        }

        if (cleanUrl.includes('.mpd')) {
            return { type: 'dash', mimeType: 'application/dash+xml', isLive: true };
        }

        if (url.includes('/hls/') || url.includes('type=hls')) {
            return { type: 'hls', mimeType: 'application/x-mpegURL', isLive: true };
        }

        if (url.includes('/dash/') || url.includes('type=dash')) {
            return { type: 'dash', mimeType: 'application/dash+xml', isLive: true };
        }

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

    get(key) {
        return this.data[key];
    }

    set(key, value) {
        const oldValue = this.data[key];
        this.data[key] = value;
        this.emit('stateChange', { key, value, oldValue });
        return this;
    }

    update(updates) {
        Object.entries(updates).forEach(([key, value]) => this.set(key, value));
        return this;
    }

    getCache(type) {
        return this.caches[type];
    }

    clearCaches() {
        Object.values(this.caches).forEach(cache => cache.clear());
    }

    destroy() {
        this.clearCaches();
        super.destroy();
    }
}

// ===== DATABASE MANAGER =====
class DatabaseManager {
    constructor() {
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                ['playlists', 'epg'].forEach(storeName => {
                    if (db.objectStoreNames.contains(storeName)) {
                        db.deleteObjectStore(storeName);
                    }
                    db.createObjectStore(storeName, { keyPath: 'url' });
                });
            };

            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };

            request.onerror = reject;
        });
    }

    async store(storeName, data) {
        const transaction = this.db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        return new Promise((resolve, reject) => {
            const request = store.put(data);
            request.onsuccess = resolve;
            request.onerror = reject;
        });
    }

    async get(storeName, key) {
        const transaction = this.db.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        return new Promise((resolve) => {
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
        });
    }

    async getAll(storeName) {
        const transaction = this.db.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        return new Promise((resolve) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => resolve([]);
        });
    }

    async clear(storeName) {
        const transaction = this.db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        store.clear();
    }
}

// ===== NOTIFICATION SYSTEM =====
class NotificationManager {
    constructor() {
        this.container = null;
        this.init();
    }

    init() {
        this.createContainer();
        this.addStyles();
    }

    createContainer() {
        this.container = document.createElement('div');
        this.container.id = 'notification-container';
        this.container.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            pointer-events: none;
        `;
        document.body.appendChild(this.container);
    }

    addStyles() {
        if (document.getElementById('notification-styles')) return;

        const style = document.createElement('style');
        style.id = 'notification-styles';
        style.textContent = `
            .notification-popup {
                background: #fff;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                padding: 16px 20px;
                margin-bottom: 10px;
                min-width: 300px;
                max-width: 400px;
                pointer-events: all;
                transform: translateX(400px);
                transition: transform 0.3s ease-out;
                display: flex;
                align-items: center;
                gap: 12px;
                position: relative;
            }

            .notification-popup.show { transform: translateX(0); }
            .notification-popup.success { border-left: 4px solid #4CAF50; }
            .notification-popup.error { border-left: 4px solid #f44336; }
            .notification-popup.info { border-left: 4px solid #2196F3; }

            .notification-icon {
                font-size: 24px;
                flex-shrink: 0;
            }

            .notification-icon.success { color: #4CAF50; }
            .notification-icon.error { color: #f44336; }
            .notification-icon.info { color: #2196F3; }

            .notification-content { flex: 1; }

            .notification-title {
                font-weight: 600;
                margin-bottom: 4px;
                color: #333;
            }

            .notification-message {
                color: #666;
                font-size: 14px;
            }

            .notification-close {
                position: absolute;
                top: 8px;
                right: 8px;
                background: none;
                border: none;
                color: #999;
                font-size: 20px;
                cursor: pointer;
                padding: 0;
                width: 24px;
                height: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 4px;
                transition: background 0.2s;
            }

            .notification-close:hover {
                background: #f5f5f5;
                color: #666;
            }
        `;
        document.head.appendChild(style);
    }

    show(title, message, type = 'success', duration = CONFIG.NOTIFICATION_DURATION) {
        const notification = this.createNotification(title, message, type);
        this.container.appendChild(notification);

        requestAnimationFrame(() => notification.classList.add('show'));

        const close = () => {
            notification.classList.remove('show');
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        };

        notification.querySelector('.notification-close').addEventListener('click', close);

        if (duration > 0) {
            setTimeout(close, duration);
        }

        return notification;
    }

    createNotification(title, message, type) {
        const icons = { success: '✓', error: '✕', info: 'ℹ' };

        const notification = document.createElement('div');
        notification.className = `notification-popup ${type}`;
        notification.innerHTML = `
            <div class="notification-icon ${type}">${icons[type]}</div>
            <div class="notification-content">
                <div class="notification-title">${title}</div>
                ${message ? `<div class="notification-message">${message}</div>` : ''}
            </div>
            <button class="notification-close">&times;</button>
        `;

        return notification;
    }
}

// ===== TIME MANAGER =====
class TimeManager {
    constructor() {
        this.userOffset = -new Date().getTimezoneOffset() / 60;
        this.epgOffset = CONFIG.EPG_TIMEZONE_OFFSET;
        this.diff = this.userOffset - this.epgOffset;
        this.parseCache = new Cache(500);
    }

    parseEPGTime(timeStr) {
        if (!timeStr) return new Date();

        const cached = this.parseCache.get(timeStr);
        if (cached) return cached;

        const year = parseInt(timeStr.slice(0, 4), 10);
        const month = parseInt(timeStr.slice(4, 6), 10) - 1;
        const day = parseInt(timeStr.slice(6, 8), 10);
        const hour = parseInt(timeStr.slice(8, 10), 10);
        const minute = parseInt(timeStr.slice(10, 12), 10);
        const second = parseInt(timeStr.slice(12, 14), 10) || 0;

        const epgDate = new Date(year, month, day, hour, minute, second);
        const adjustedTime = new Date(epgDate.getTime() + (this.diff * 3600000));

        this.parseCache.set(timeStr, adjustedTime);
        return adjustedTime;
    }

    formatTime(date) {
        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    }

    getTimezoneDisplay() {
        const userOffsetStr = (this.userOffset >= 0 ? '+' : '') + this.userOffset + ' UTC';
        return `<i class="fas fa-clock"></i> Ваш часовой пояс: ${userOffsetStr}`;
    }
}

// ===== EPG MANAGER =====
class EPGManager extends EventEmitter {
    constructor(database, timeManager) {
        super();
        this.db = database;
        this.timeManager = timeManager;
        this.epgCache = {};
        this.matchCache = new Cache(CONFIG.MAX_CACHE_SIZE);
        this.programCache = new Cache(50);
        this.updateTimer = null;
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
                headers: {
                    'Accept': 'application/xml, text/xml, */*'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const text = await response.text();

            await this.db.store('epg', {
                url: CONFIG.EPG_URL,
                data: text,
                timestamp: Date.now()
            });

            this.parseEPG(text);
            this.emit('loaded', this.epgCache);
        } catch (error) {
            const cached = await this.db.get('epg', CONFIG.EPG_URL);
            if (cached) {
                this.parseEPG(cached.data);
                this.emit('loaded', this.epgCache);
                this.emit('offline', 'Загружена из кэша (офлайн режим)');
            } else {
                this.emit('error', error);
                throw error;
            }
        }
    }

    parseEPG(xmlText) {
        this.epgCache = {};

        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");

        const channels = xmlDoc.getElementsByTagName('channel');

        for (const channel of channels) {
            const id = channel.getAttribute('id');
            if (!id) continue;

            const displayNames = Array.from(channel.getElementsByTagName('display-name'))
                .map(el => el.textContent?.trim())
                .filter(Boolean);

            const icon = channel.getElementsByTagName('icon')[0];
            const iconSrc = icon?.getAttribute('src');

            this.epgCache[id] = {
                names: displayNames,
                icon: iconSrc,
                programs: []
            };
        }

        const programs = xmlDoc.getElementsByTagName('programme');
        for (const program of programs) {
            const channelId = program.getAttribute('channel');
            const start = program.getAttribute('start');
            const stop = program.getAttribute('stop');

            if (!channelId || !start || !stop) continue;

            const titleEl = program.getElementsByTagName('title')[0];
            const descEl = program.getElementsByTagName('desc')[0];

            if (this.epgCache[channelId]) {
                this.epgCache[channelId].programs.push({
                    start,
                    stop,
                    title: titleEl?.textContent?.trim() || 'Нет названия',
                    desc: descEl?.textContent?.trim() || ''
                });
            }
        }

        Object.values(this.epgCache).forEach(channel => {
            if (channel.programs.length > 0) {
                channel.programs.sort((a, b) => a.start.localeCompare(b.start));
            }
        });
    }

    findMatchingChannel(channelName) {
        if (!channelName) return null;

        const cached = this.matchCache.get(channelName);
        if (cached) return cached;

        const result = this.performChannelMatch(channelName);
        this.matchCache.set(channelName, result);
        return result;
    }

    performChannelMatch(channelName) {
        if (!channelName || Object.keys(this.epgCache).length === 0) return null;

        const channelVariants = ChannelNameNormalizer.getChannelVariants(channelName);
        const channelKeywords = ChannelNameNormalizer.extractKeywords(channelName);

        // 1. Точное совпадение оригинального названия
        for (const [channelId, data] of Object.entries(this.epgCache)) {
            for (const epgName of data.names) {
                if (epgName.toLowerCase().trim() === channelName.toLowerCase().trim()) {
                    return { channelId, ...data };
                }
            }
        }

        // 2. Точное совпадение нормализованных названий
        for (const variant of channelVariants) {
            for (const [channelId, data] of Object.entries(this.epgCache)) {
                for (const epgName of data.names) {
                    const normalizedEpgName = ChannelNameNormalizer.normalizeChannelName(epgName);
                    if (normalizedEpgName === variant) {
                        return { channelId, ...data };
                    }
                }
            }
        }

        // 3. Поиск по содержанию основных ключевых слов
        const mainChannelKeywords = channelKeywords.filter(word => word.length > 2);
        if (mainChannelKeywords.length > 0) {
            for (const [channelId, data] of Object.entries(this.epgCache)) {
                for (const epgName of data.names) {
                    const epgKeywords = ChannelNameNormalizer.extractKeywords(epgName);

                    const matchCount = mainChannelKeywords.filter(keyword =>
                        epgKeywords.some(epgKeyword =>
                            epgKeyword.includes(keyword) || keyword.includes(epgKeyword)
                        )
                    ).length;

                    if (matchCount >= Math.ceil(mainChannelKeywords.length / 2)) {
                        return { channelId, ...data };
                    }
                }
            }
        }

        // 4. Поиск по первому главному слову
        const firstWord = mainChannelKeywords[0];
        if (firstWord && firstWord.length > 2) {
            for (const [channelId, data] of Object.entries(this.epgCache)) {
                for (const epgName of data.names) {
                    const epgFirstWord = ChannelNameNormalizer.extractKeywords(epgName)[0];
                    if (epgFirstWord && (
                        epgFirstWord.includes(firstWord) ||
                        firstWord.includes(epgFirstWord) ||
                        this.isSimilar(firstWord, epgFirstWord)
                    )) {
                        return { channelId, ...data };
                    }
                }
            }
        }

        // 5. Поиск по частичному совпадению
        for (const variant of channelVariants) {
            if (variant.length < 3) continue;

            for (const [channelId, data] of Object.entries(this.epgCache)) {
                for (const epgName of data.names) {
                    const normalizedEpgName = ChannelNameNormalizer.normalizeChannelName(epgName);

                    if (normalizedEpgName.includes(variant) || variant.includes(normalizedEpgName)) {
                        return { channelId, ...data };
                    }
                }
            }
        }

        return null;
    }

    isSimilar(str1, str2) {
        if (!str1 || !str2) return false;

        const maxLen = Math.max(str1.length, str2.length);
        if (maxLen === 0) return true;

        const distance = this.levenshteinDistance(str1, str2);
        const similarity = (maxLen - distance) / maxLen;

        return similarity >= 0.7;
    }

    levenshteinDistance(str1, str2) {
        const matrix = [];

        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }

        return matrix[str2.length][str1.length];
    }

    getCurrentProgram(channelName, epgData) {
        if (!epgData?.programs?.length) {
            return 'Информация о программе недоступна';
        }

        const now = new Date();

        for (const program of epgData.programs) {
            const startTime = this.timeManager.parseEPGTime(program.start);
            const endTime = this.timeManager.parseEPGTime(program.stop);

            if (now >= startTime && now < endTime) {
                return `${program.title} • до ${this.timeManager.formatTime(endTime)}`;
            }
        }

        for (const program of epgData.programs) {
            const startTime = this.timeManager.parseEPGTime(program.start);
            if (startTime > now) {
                return `Далее: ${program.title} • в ${this.timeManager.formatTime(startTime)}`;
            }
        }

        return 'Информация о программе недоступна';
    }

    getProgressBar(epgData) {
        if (!epgData?.programs?.length) return '';

        const now = new Date();

        for (const program of epgData.programs) {
            const startTime = this.timeManager.parseEPGTime(program.start);
            const endTime = this.timeManager.parseEPGTime(program.stop);

            if (now >= startTime && now < endTime) {
                const programDuration = endTime.getTime() - startTime.getTime();
                const elapsedTime = now.getTime() - startTime.getTime();
                const progress = Math.min(100, Math.max(0, (elapsedTime / programDuration) * 100));

                return `<div class="channel-progress-container">
                        <div class="channel-progress-bar" style="width:${progress.toFixed(1)}%"></div>
                    </div>`;
            }
        }
        return '';
    }

    startUpdates() {
        this.stopUpdates();
        this.updateTimer = setInterval(() => {
            this.programCache.clear();
            this.matchCache.clear();
            this.timeManager.parseCache.clear();
            this.emit('update');
        }, CONFIG.EPG_UPDATE_INTERVAL);
    }

    stopUpdates() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
    }

    async refresh() {
        await this.db.clear('epg');
        this.matchCache.clear();
        this.programCache.clear();
        await this.load(true);
    }

    destroy() {
        this.stopUpdates();
        super.destroy();
    }
}

// ===== PLAYLIST MANAGER =====
class PlaylistManager extends EventEmitter {
    constructor(database) {
        super();
        this.db = database;
        this.channels = [];
        this.groups = [];
    }

    async loadFromUrl(url) {
        try {
            const response = await fetch(url, {
                method: 'GET',
                mode: 'cors',
                cache: 'no-cache',
                headers: {
                    'Accept': 'application/x-mpegurl, application/vnd.apple.mpegurl, audio/mpegurl, audio/x-mpegurl, video/x-mpegurl, video/mpegurl, application/m3u8, audio/m3u8, */*',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const text = await response.text();

            if (!text) {
                throw new Error('Пустой ответ от сервера');
            }

            return this.processPlaylist(text, url);
        } catch (error) {
            throw new Error(`Не удалось загрузить плейлист: ${error.message}`);
        }
    }

    async loadFromFile(file) {
        const validExtensions = ['.m3u', '.m3u8', '.txt'];
        const isValid = validExtensions.some(ext => file.name.toLowerCase().endsWith(ext));

        if (!isValid) {
            throw new Error(`Поддерживаются только файлы ${validExtensions.join(', ')}`);
        }

        const text = await this.readFileAsText(file);

        if (!text.includes('#EXTM3U') && !text.includes('#EXTINF')) {
            throw new Error('Файл не является валидным M3U плейлистом');
        }

        return this.processPlaylist(text, 'file_' + file.name);
    }

    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = () => reject(new Error('Ошибка чтения файла'));
            reader.readAsText(file);
        });
    }

    async processPlaylist(playlistText, url) {
        try {
            await this.db.clear('playlists');

            await this.db.store('playlists', {
                url: url,
                data: playlistText,
                timestamp: Date.now()
            });

            this.parseM3U8(playlistText);

            this.emit('loaded', {
                channels: this.channels,
                groups: this.groups,
                url: url
            });

            return { channels: this.channels, groups: this.groups };
        } catch (error) {
            throw new Error(`Ошибка обработки плейлиста: ${error.message}`);
        }
    }

    parseM3U8(text) {
        this.channels = [];
        this.groups = [];
        const groupSet = new Set();

        let currentChannel = null;
        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            if (line.startsWith('#EXTINF:')) {
                currentChannel = this.parseExtinf(line);
            } else if (line.startsWith('#EXTGRP:')) {
                if (currentChannel && !currentChannel.group) {
                    currentChannel.group = line.slice(8).trim();
                }
            } else if (this.isValidUrl(line)) {
                if (currentChannel) {
                    currentChannel.url = line;
                    currentChannel.format = StreamFormatDetector.detectFormat(line);

                    if (!currentChannel.name) {
                        currentChannel.name = `Канал ${this.channels.length + 1}`;
                    }

                    if (currentChannel.group) {
                        groupSet.add(currentChannel.group);
                    } else {
                        currentChannel.group = 'Без группы';
                        groupSet.add('Без группы');
                    }

                    this.channels.push(currentChannel);
                    currentChannel = null;
                }
            }
        }

        this.groups = Array.from(groupSet).sort();
    }

    parseExtinf(line) {
        const extinf = line.slice(8);
        const channel = {};

        const commaIndex = extinf.lastIndexOf(',');
        if (commaIndex === -1) {
            channel.name = extinf.trim();
            return channel;
        }

        const attributesStr = extinf.slice(0, commaIndex).trim();
        channel.name = extinf.slice(commaIndex + 1).trim();

        const quotedAttrRegex = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g;
        let match;
        while ((match = quotedAttrRegex.exec(attributesStr)) !== null) {
            const attrName = match[1];
            const attrValue = match[2];

            channel[attrName] = attrValue;

            if (attrName === 'group-title') {
                channel.group = attrValue;
            } else if (attrName === 'tvg-logo') {
                channel.icon = attrValue;
            }
        }

        const unquotedAttrRegex = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*([^\s"]+)/g;
        while ((match = unquotedAttrRegex.exec(attributesStr)) !== null) {
            const attrName = match[1];
            const attrValue = match[2];

            if (!channel[attrName]) {
                channel[attrName] = attrValue;

                if (attrName === 'tvg-logo') {
                    channel.icon = attrValue;
                }
            }
        }

        return channel;
    }

    isValidUrl(url) {
        return /^(https?|rtmp|rtsp):\/\//i.test(url);
    }
}

// ===== RENDERER =====
class ChannelRenderer {
    constructor(epgManager, appState) {
        this.epgManager = epgManager;
        this.appState = appState;
    }

    renderChannels(container, channels, filter = '', group = '') {
        if (!container) return [];

        const filteredChannels = this.filterChannels(channels, filter, group);

        if (filteredChannels.length === 0) {
            container.innerHTML = '<div class="no-results">Каналы не найдены</div>';
            return [];
        }

        const performance = this.appState.get('devicePerformance');
        const batchSize = CONFIG.BATCH_SIZE[performance];
        const channelsToRender = filteredChannels.slice(0, batchSize);

        this.renderBatch(container, channelsToRender);

        if (filteredChannels.length > batchSize) {
            this.addLoadMoreButton(container, filteredChannels, batchSize);
        }

        return filteredChannels;
    }

    filterChannels(channels, filter, group) {
        if (!filter && !group) return channels;

        return channels.filter(channel => {
            const nameMatch = !filter || channel.name.toLowerCase().includes(filter.toLowerCase());
            const groupMatch = !group || channel.group === group;
            return nameMatch && groupMatch;
        });
    }

    renderBatch(container, channels) {
        container.innerHTML = '';
        const fragment = document.createDocumentFragment();

        channels.forEach(channel => {
            const element = this.createChannelElement(channel);
            fragment.appendChild(element);
        });

        container.appendChild(fragment);
    }

    createChannelElement(channel) {
        const epgData = this.epgManager.findMatchingChannel(channel.name);
        const currentProgram = this.epgManager.getCurrentProgram(channel.name, epgData);
        const progressBar = this.epgManager.getProgressBar(epgData);

        const element = document.createElement('div');
        element.className = 'channel-item';
        element.dataset.url = channel.url;
        element.tabIndex = 0;

        let logoSrc = '/css/no_logo.png';

        if (epgData?.icon) {
            logoSrc = epgData.icon;
        } else if (channel.icon) {
            logoSrc = channel.icon;
        } else if (channel['tvg-logo']) {
            logoSrc = channel['tvg-logo'];
        }

        element.innerHTML = `
            <img class="channel-logo"
                 src="${logoSrc}"
                 alt="${channel.name}"
                 onerror="this.onerror=null; this.src='/css/no_logo.png';"
                 onload="this.style.opacity='1';"
                 style="opacity:0.5; transition: opacity 0.3s;">
            <div class="channel-info">
                <div class="channel-name" title="${channel.name}">${channel.name}</div>
                <div class="channel-program" title="${currentProgram}">${currentProgram}</div>
                ${progressBar}
            </div>
        `;

        const currentChannel = this.appState.get('currentChannel');
        if (currentChannel?.url === channel.url) {
            element.classList.add('active');
        }

        element.addEventListener('click', () => {
            const freshEpgData = this.epgManager.findMatchingChannel(channel.name);
            this.appState.emit('channelSelected', { channel, epgData: freshEpgData });
        });

        element.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const freshEpgData = this.epgManager.findMatchingChannel(channel.name);
                this.appState.emit('channelSelected', { channel, epgData: freshEpgData });
            }
        });

        return element;
    }

    addLoadMoreButton(container, filteredChannels, currentCount) {
        const loadMoreBtn = document.createElement('div');
        loadMoreBtn.className = 'load-more-btn';
        loadMoreBtn.innerHTML = `<button class="btn btn-secondary">Показать еще (${filteredChannels.length - currentCount})</button>`;

        loadMoreBtn.addEventListener('click', () => {
            const performance = this.appState.get('devicePerformance');
            const batchSize = CONFIG.BATCH_SIZE[performance];
            const nextBatch = filteredChannels.slice(currentCount, currentCount + batchSize);

            loadMoreBtn.remove();

            const fragment = document.createDocumentFragment();
            nextBatch.forEach(channel => {
                const element = this.createChannelElement(channel);
                fragment.appendChild(element);
            });
            container.appendChild(fragment);

            const newCount = currentCount + batchSize;
            if (newCount < filteredChannels.length) {
                this.addLoadMoreButton(container, filteredChannels, newCount);
            }
        });

        container.appendChild(loadMoreBtn);
    }
}

// ===== EPG RENDERER =====
class EPGRenderer {
    constructor(timeManager) {
        this.timeManager = timeManager;
    }

    render(container, epgData) {
        if (!container) return;

        if (!epgData?.programs?.length) {
            container.innerHTML = '<div class="no-results">Нет данных о программе</div>';
            return;
        }

        container.innerHTML = '<div class="epg-program-list"></div>';
        const programList = container.querySelector('.epg-program-list');

        const programs = this.getRelevantPrograms(epgData.programs);
        const fragment = document.createDocumentFragment();

        programs.forEach(program => {
            const element = this.createProgramElement(program);
            fragment.appendChild(element);
        });

        programList.appendChild(fragment);
    }

    getRelevantPrograms(programs) {
        const now = new Date();
        const relevantPrograms = [];
        let foundCurrent = false;

        for (const program of programs) {
            const startTime = this.timeManager.parseEPGTime(program.start);
            const endTime = this.timeManager.parseEPGTime(program.stop);

            if (endTime < now) continue;

            const isCurrent = !foundCurrent && startTime <= now && now < endTime;

            const programData = {
                ...program,
                startTime,
                endTime,
                isCurrent
            };

            if (programData.isCurrent) {
                foundCurrent = true;
            }

            relevantPrograms.push(programData);

            if (relevantPrograms.length >= 10) break;
        }

        return relevantPrograms;
    }

    createProgramElement(program) {
        const element = document.createElement('div');
        element.className = `epg-program-item ${program.isCurrent ? 'current-program' : ''}`;

        const timeStr = `${this.timeManager.formatTime(program.startTime)} - ${this.timeManager.formatTime(program.endTime)}`;
        const duration = Math.round((program.endTime - program.startTime) / 60000);

        element.innerHTML = `
            <div class="epg-program-time">${timeStr} <span class="duration">(${duration} мин)</span></div>
            <div class="epg-program-title">${program.title}</div>
            ${program.isCurrent ? '<div class="epg-current-badge">Сейчас</div>' : ''}
        `;

        if (program.desc) {
            element.title = program.desc;
        }

        return element;
    }
}

// ===== PLAYER MANAGER =====
class PlayerManager extends EventEmitter {
    constructor(appState) {
        super();
        this.appState = appState;
        this.currentPlayer = null;
    }

    play(channel, epgData) {
        this.appState.set('currentChannel', { ...channel, epgData });
        this.emit('channelChanged', channel);

        this.updateActiveChannel(channel.url);
        this.initializePlayer(channel);
    }

    updateActiveChannel(url) {
        document.querySelectorAll('.channel-item').forEach(item => {
            item.classList.toggle('active', item.dataset.url === url);
        });
    }

    initializePlayer(channel) {
        const container = document.getElementById('player-container');
        if (!container) return;

        container.innerHTML = '<div id="player"></div>';

        if (this.currentPlayer) {
            try {
                this.currentPlayer.destroy();
            } catch (e) {
                console.warn('Player destroy failed:', e);
            }
            this.currentPlayer = null;
        }

        const performance = this.appState.get('devicePerformance');
        const isHLS = channel.url.includes('.m3u8');

        if (!window.VenomPlayer || !isHLS || performance === 'low') {
            this.createNativePlayer(container, channel);
            return;
        }

        this.createVenomPlayer(container, channel, performance);
    }

    createNativePlayer(container, channel) {
        const isHLS = channel.url.includes('.m3u8');
        const isMPD = channel.url.includes('.mpd');

        const mimeType = isHLS ? 'application/x-mpegURL' :
            isMPD ? 'application/dash+xml' : 'video/mp4';

        container.innerHTML = `
            <video controls autoplay style="width:100%;height:100%;background:#000;">
                <source src="${channel.url}" type="${mimeType}">
                Ваш браузер не поддерживает видео элемент.
            </video>
        `;
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
                        names: ["Оригинал", "Русский дубляж", "Русский перевод"],
                        order: [0, 1, 2]
                    },
                    cc: [
                        { name: "Русские", url: channel.subtitles?.ru },
                        { name: "English", url: channel.subtitles?.en }
                    ].filter(subtitle => subtitle.url)
                },
                hlsConfig: {
                    maxBufferLength: 30,
                    maxMaxBufferLength: 60,
                    liveSyncDuration: 3,
                    liveMaxLatencyDuration: 10,
                    lowLatencyMode: true,
                    startLevel: -1,
                    capLevelToPlayerSize: true,
                    maxAutoLevel: Number.MAX_VALUE,
                    manifestLoadingTimeOut: 10000,
                    manifestLoadingMaxRetry: 3,
                    levelLoadingTimeOut: 10000,
                    levelLoadingMaxRetry: 4,
                    enableWorker: true,
                    enableSoftwareAES: true,
                    ...(performance !== 'low' && {
                        maxBufferSize: 60 * 1000 * 1000,
                        maxBufferHole: 0.5
                    })
                },
                speed: [0.75, 1, 1.25],
                restrictQuality: function(quality) {
                    return false;
                },
                restrictSpeed: function(rate, quality) {
                    if (rate !== 1) {
                        return 'Изменение скорости недоступно для прямых трансляций';
                    }
                },
                text: {
                    settings: "Настройки",
                    quality: "Качество",
                    sound: "Аудиодорожка",
                    speed: "Скорость",
                    cc: "Субтитры",
                    online: "Прямой эфир",
                    mute: "Отключить звук",
                    unMute: "Включить звук",
                    fullscreenEnter: "Полноэкранный режим",
                    fullscreenExit: "Выход из полноэкранного режима",
                    pipIn: "Картинка в картинке",
                    pipOut: "Выйти из режима картинка в картинке"
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
                            return 'Авто';
                        }

                        if (height >= 2160) return '4K ' + height + 'p';
                        if (height >= 1440) return '2K ' + height + 'p';
                        if (height >= 1080) return 'FullHD ' + height + 'p';
                        if (height >= 720) return 'HD ' + height + 'p';
                        if (height >= 480) return 'SD ' + height + 'p';
                        return height + 'p';
                    },
                    speed: function(rate) {
                        return rate === 1 ? 'Обычная' : 'x' + rate;
                    }
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

        this.currentPlayer.on('error', (error) => {
            setTimeout(() => {
                if (this.currentPlayer) {
                    this.currentPlayer.load();
                }
            }, 5000);
        });

        this.currentPlayer.on('ready', () => {
            if (this.currentPlayer.live) {
                this.currentPlayer.seekToLive();
            }

            const savedQuality = localStorage.getItem('preferredQuality');
            const savedAudio = localStorage.getItem('preferredAudio');

            if (savedQuality && this.currentPlayer.getQualityLevels) {
                const levels = this.currentPlayer.getQualityLevels();
                const targetLevel = levels.find(level => level.height == savedQuality);
                if (targetLevel) {
                    this.currentPlayer.setCurrentLevel(targetLevel.level);
                }
            }

            if (savedAudio && this.currentPlayer.setCurrentAudioTrack) {
                this.currentPlayer.setCurrentAudioTrack(parseInt(savedAudio));
            }
        });

        this.currentPlayer.on('qualitychange', (event) => {
            const quality = event.level || event.quality;
            if (quality && quality.height) {
                localStorage.setItem('preferredQuality', quality.height);
            }
        });

        this.currentPlayer.on('audiochange', (audioTrack) => {
            localStorage.setItem('preferredAudio', audioTrack);
        });

        this.setupPlayerSecurity();
    }

    setupPlayerSecurity() {
        setTimeout(() => {
            const playerElement = document.getElementById('player');
            if (playerElement) {
                const disableContextMenu = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                };

                playerElement.addEventListener('contextmenu', disableContextMenu, true);
                this.hidePlayerBranding();
                this.blockDevKeys();
            }
        }, 1000);
    }

    hidePlayerBranding() {
        const style = document.createElement('style');
        style.id = 'venom-custom-hide';
        style.textContent = `
            #player [class*="version"],
            #player .venom-version,
            #player .player-version,
            #player [data-action="copy"],
            #player [title*="Копировать"],
            #player .context-menu,
            #player *:contains("VenomPlayer") {
                display: none !important;
                visibility: hidden !important;
                opacity: 0 !important;
                pointer-events: none !important;
            }

            #player .live-indicator {
                background: var(--color-live, #ff4757) !important;
                animation: pulse 2s infinite !important;
            }

            @keyframes pulse {
                0% { opacity: 1; }
                50% { opacity: 0.5; }
                100% { opacity: 1; }
            }
        `;

        const existingStyle = document.getElementById('venom-custom-hide');
        if (existingStyle) {
            existingStyle.remove();
        }
        document.head.appendChild(style);
    }

    blockDevKeys() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'F12' ||
                (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J')) ||
                (e.ctrlKey && e.key === 'u')) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        }, true);
    }
}

// ===== MAIN APPLICATION =====
class IPTVApp {
    constructor() {
        this.components = {};
        this.eventUnsubscribers = [];
    }

    async init() {
        try {
            this.components.appState = new AppState();
            this.components.database = new DatabaseManager();
            this.components.notifications = new NotificationManager();
            this.components.timeManager = new TimeManager();

            await this.components.database.init();
            this.components.appState.set('db', this.components.database);

            this.components.epgManager = new EPGManager(
                this.components.database,
                this.components.timeManager
            );
            this.components.playlistManager = new PlaylistManager(this.components.database);
            this.components.playerManager = new PlayerManager(this.components.appState);

            this.components.channelRenderer = new ChannelRenderer(
                this.components.epgManager,
                this.components.appState
            );
            this.components.epgRenderer = new EPGRenderer(this.components.timeManager);

            this.setupEventListeners();
            this.setupUI();
            await this.loadInitialData();

        } catch (error) {
            console.error('Failed to initialize IPTV App:', error);
            this.components.notifications?.show('Ошибка инициализации', error.message, 'error');
        }
    }

    setupEventListeners() {
        const { appState, epgManager, playlistManager, playerManager, notifications } = this.components;

        this.subscribe(playlistManager, 'loaded', ({ channels, groups, url }) => {
            appState.clearCaches();
            appState.update({ channels, groups });
            this.updateGroupFilter(groups);
            this.renderChannels();
            notifications.show('Плейлист загружен', `Загружено ${channels.length} каналов`, 'success');
            epgManager.load().catch(() => {});
        });

        this.subscribe(epgManager, 'loaded', (epgData) => {
            appState.set('epgData', epgData);
            this.renderChannels();
            epgManager.startUpdates();
            const channelsCount = Object.keys(epgData).length;
            notifications.show('Программа передач загружена', `Для ${channelsCount} каналов`, 'success');
        });

        this.subscribe(epgManager, 'offline', (message) => {
            notifications.show('Программа передач', message, 'info');
        });

        this.subscribe(epgManager, 'update', () => {
            epgManager.matchCache.clear();
            epgManager.programCache.clear();
            this.updateVisibleChannelPrograms();

            const currentChannel = appState.get('currentChannel');
            if (currentChannel?.epgData) {
                const freshEpgData = epgManager.findMatchingChannel(currentChannel.name);
                this.renderEPG(freshEpgData);
            }
        });

        this.subscribe(appState, 'channelSelected', ({ channel, epgData }) => {
            const freshEpgData = epgManager.findMatchingChannel(channel.name);
            playerManager.play(channel, freshEpgData);
            this.renderEPG(freshEpgData);
        });

        this.subscribe(epgManager, 'error', (error) => {
            console.error('EPG error:', error);
            notifications.show('Ошибка EPG', error.message, 'error');
        });

        this.subscribe(playlistManager, 'error', (error) => {
            console.error('Playlist error:', error);
            notifications.show('Ошибка плейлиста', error.message, 'error');
        });
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
        const timezoneDisplay = document.getElementById('timezone-display');
        if (timezoneDisplay) {
            timezoneDisplay.innerHTML = this.components.timeManager.getTimezoneDisplay();
        }
    }

    setupDialogs() {
        this.setupPlaylistDialog();
        this.setupEpgDialog();
    }

    setupPlaylistDialog() {
        const dialog = document.getElementById('playlist-dialog');
        if (!dialog) return;

        const closeDialog = () => dialog.classList.remove('active');

        dialog.querySelector('.dialog-close')?.addEventListener('click', closeDialog);
        document.getElementById('cancel-load-btn')?.addEventListener('click', closeDialog);

        dialog.querySelectorAll('.dialog-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.dialog-content').forEach(content => {
                    content.classList.remove('active');
                });
                document.getElementById(tab.dataset.tab)?.classList.add('active');

                dialog.querySelectorAll('.dialog-tab').forEach(t => {
                    t.classList.toggle('active', t === tab);
                    t.setAttribute('aria-selected', t === tab);
                });
            });
        });

        const fileInput = document.getElementById('playlist-file');
        const loadFileBtn = document.getElementById('load-file-btn');
        const fileNameDisplay = document.getElementById('file-name');

        if (fileInput && loadFileBtn && fileNameDisplay) {
            fileInput.addEventListener('change', function() {
                if (this.files?.length > 0) {
                    fileNameDisplay.textContent = this.files[0].name;
                    loadFileBtn.disabled = false;
                } else {
                    fileNameDisplay.textContent = 'Файл не выбран';
                    loadFileBtn.disabled = true;
                }
            });

            loadFileBtn.addEventListener('click', async () => {
                if (!fileInput.files?.length) return;

                const file = fileInput.files[0];
                const statusEl = document.getElementById('file-status');

                if (statusEl) {
                    statusEl.textContent = 'Загрузка...';
                    statusEl.className = 'status-message';
                }

                try {
                    loadFileBtn.disabled = true;
                    await this.components.playlistManager.loadFromFile(file);
                    if (statusEl) {
                        statusEl.textContent = 'Плейлист успешно загружен';
                        statusEl.className = 'status-message status-success';
                    }
                    setTimeout(closeDialog, 1500);
                } catch (error) {
                    if (statusEl) {
                        statusEl.textContent = 'Ошибка: ' + error.message;
                        statusEl.className = 'status-message status-error';
                    }
                } finally {
                    loadFileBtn.disabled = false;
                }
            });
        }

        const urlInput = document.getElementById('playlist-url');
        const loadUrlBtn = document.getElementById('load-url-btn');

        if (urlInput && loadUrlBtn) {
            loadUrlBtn.addEventListener('click', async () => {
                const url = urlInput.value.trim();
                const statusEl = document.getElementById('url-status');

                if (!url) {
                    if (statusEl) {
                        statusEl.textContent = 'Введите URL плейлиста';
                        statusEl.className = 'status-message status-error';
                    }
                    return;
                }

                if (statusEl) {
                    statusEl.textContent = 'Загрузка...';
                    statusEl.className = 'status-message';
                }

                try {
                    loadUrlBtn.disabled = true;
                    await this.components.playlistManager.loadFromUrl(url);
                    if (statusEl) {
                        statusEl.textContent = 'Плейлист успешно загружен';
                        statusEl.className = 'status-message status-success';
                    }
                    setTimeout(closeDialog, 1500);
                } catch (error) {
                    if (statusEl) {
                        statusEl.textContent = 'Ошибка: ' + error.message;
                        statusEl.className = 'status-message status-error';
                    }
                } finally {
                    loadUrlBtn.disabled = false;
                }
            });
        }

        const loadDefaultBtn = document.getElementById('load-default-btn');
        if (loadDefaultBtn) {
            loadDefaultBtn.addEventListener('click', async () => {
                const statusEl = document.getElementById('default-status');

                if (statusEl) {
                    statusEl.textContent = 'Загрузка тестового плейлиста...';
                    statusEl.className = 'status-message';
                }

                try {
                    loadDefaultBtn.disabled = true;
                    await this.components.playlistManager.loadFromUrl(CONFIG.DEFAULT_PLAYLIST_URL);
                    if (statusEl) {
                        statusEl.textContent = 'Тестовый плейлист успешно загружен';
                        statusEl.className = 'status-message status-success';
                    }
                    setTimeout(closeDialog, 1500);
                } catch (error) {
                    if (statusEl) {
                        statusEl.textContent = 'Ошибка: ' + error.message;
                        statusEl.className = 'status-message status-error';
                    }
                } finally {
                    loadDefaultBtn.disabled = false;
                }
            });
        }

        this.showPlaylistDialog = () => {
            dialog.classList.add('active');
        };
    }

    setupEpgDialog() {
        const dialog = document.getElementById('epg-dialog');
        if (!dialog) return;

        const closeDialog = () => dialog.classList.remove('active');

        dialog.querySelector('.dialog-close')?.addEventListener('click', closeDialog);
        document.getElementById('cancel-epg-btn')?.addEventListener('click', closeDialog);

        const refreshBtn = document.getElementById('refresh-epg-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                const statusEl = document.getElementById('epg-status');

                if (statusEl) {
                    statusEl.textContent = 'Обновление EPG...';
                    statusEl.className = 'status-message';
                }

                try {
                    refreshBtn.disabled = true;
                    await this.components.epgManager.refresh();
                    if (statusEl) {
                        statusEl.textContent = 'EPG успешно обновлен';
                        statusEl.className = 'status-message status-success';
                    }
                    this.renderChannels();
                    setTimeout(closeDialog, 1500);
                } catch (error) {
                    if (statusEl) {
                        statusEl.textContent = 'Ошибка: ' + error.message;
                        statusEl.className = 'status-message status-error';
                    }
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
            const debouncedSearch = this.debounce((value) => {
                this.components.appState.set('searchQuery', value);
                this.renderChannels();
                if (clearButton) {
                    clearButton.style.display = value ? 'flex' : 'none';
                }
            }, CONFIG.SEARCH_DEBOUNCE_DELAY);

            searchInput.addEventListener('input', (e) => debouncedSearch(e.target.value));
        }

        if (clearButton) {
            clearButton.addEventListener('click', () => {
                if (searchInput) {
                    searchInput.value = '';
                    searchInput.focus();
                }
                clearButton.style.display = 'none';
                this.components.appState.set('searchQuery', '');
                this.renderChannels();
            });
        }

        if (groupFilter) {
            groupFilter.addEventListener('change', (e) => {
                this.components.appState.set('selectedGroup', e.target.value);
                this.renderChannels();
            });
        }

        document.getElementById('refresh-epg')?.addEventListener('click', () => this.showEpgDialog());
        document.getElementById('load-new-playlist')?.addEventListener('click', () => this.showPlaylistDialog());
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
            this.components.notifications.show('Ошибка загрузки', 'Не удалось загрузить данные', 'error');
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

        const filteredChannels = channelRenderer.renderChannels(
            container,
            channels,
            searchQuery,
            selectedGroup
        );

        appState.set('filteredChannels', filteredChannels);
    }

    renderEPG(epgData) {
        const container = document.getElementById('epg-container');
        if (container) {
            this.components.epgRenderer.render(container, epgData);
        }
    }

    updateGroupFilter(groups) {
        const filter = document.getElementById('group-filter');
        if (!filter) return;

        const currentValue = filter.value;
        filter.innerHTML = '<option value="">Все группы</option>';

        groups.forEach(group => {
            const option = document.createElement('option');
            option.value = group;
            option.textContent = group;
            if (group === currentValue) {
                option.selected = true;
            }
            filter.appendChild(option);
        });
    }

    updateVisibleChannelPrograms() {
        const channelItems = document.querySelectorAll('.channel-item');
        const { epgManager } = this.components;
        const channels = this.components.appState.get('filteredChannels') || [];

        channelItems.forEach(item => {
            const channelUrl = item.dataset.url;
            const channel = channels.find(c => c.url === channelUrl);

            if (channel) {
                const epgData = epgManager.findMatchingChannel(channel.name);
                const currentProgram = epgManager.getCurrentProgram(channel.name, epgData);
                const progressBar = epgManager.getProgressBar(epgData);

                const programElement = item.querySelector('.channel-program');
                if (programElement) {
                    programElement.textContent = currentProgram;
                    programElement.title = currentProgram;
                }

                const existingProgress = item.querySelector('.channel-progress-container');
                if (existingProgress) {
                    existingProgress.remove();
                }

                if (progressBar) {
                    const channelInfo = item.querySelector('.channel-info');
                    if (channelInfo) {
                        channelInfo.insertAdjacentHTML('beforeend', progressBar);
                    }
                }
            }
        });
    }

    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    destroy() {
        this.eventUnsubscribers.forEach(unsubscribe => unsubscribe());
        Object.values(this.components).forEach(component => {
            if (typeof component.destroy === 'function') {
                component.destroy();
            }
        });
    }
}

// ===== INITIALIZATION =====
document.addEventListener('DOMContentLoaded', async () => {
    window.iptvApp = new IPTVApp();
    await window.iptvApp.init();
});

window.addEventListener('beforeunload', () => {
    if (window.iptvApp) {
        window.iptvApp.destroy();
    }
});
