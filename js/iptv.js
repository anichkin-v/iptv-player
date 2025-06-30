// ===== CONFIGURATION & CONSTANTS =====
    const CONFIG = Object.freeze({
    DB_NAME: 'IPTVDB2',
    DB_VERSION: 4,
    M3U8_EXPIRY: 365 * 24 * 60 * 60 * 1000,
    EPG_EXPIRY: 6 * 60 * 60 * 1000,
    EPG_TIMEZONE_OFFSET: 3,
    EPG_URL: 'http://exsemle.com/epg.xml',
    DEFAULT_PLAYLIST_URL: 'http://exsemple.com/playlist.php?default=1',
    CHANNELS_PER_PAGE: 3500,
    EPG_UPDATE_INTERVAL: 21600,
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
    return () => this.off(event, callback);
}

    off(event, callback) {
    this.events.get(event)?.delete(callback);
}

    emit(event, ...args) {
    this.events.get(event)?.forEach(callback => {
    try {
    callback(...args);
} catch (error) {
    console.error('Event handler error:', error);
}
});
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
    const expiry = Date.now() + ttl;
    this.set(key, { value, expiry });
}

    get(key) {
    const item = super.get(key);
    if (item?.expiry && Date.now() > item.expiry) {
    this.delete(key);
    return undefined;
}
    return item?.value ?? item;
}

    cleanup() {
    const now = Date.now();
    for (const [key, item] of this.entries()) {
    if (item?.expiry && now > item.expiry) {
    this.delete(key);
}
}
}
}

    class Performance {
    static detectLevel() {
    const memory = navigator.deviceMemory || 4;
    const cores = navigator.hardwareConcurrency || 2;
    const connection = navigator.connection;

    if (memory <= 2 || cores <= 2) return 'low';
    if (memory >= 8 && cores >= 4) return 'high';
    if (connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g') return 'low';

    return 'medium';
}

    static measure(name, fn) {
    const start = performance.now();
    const result = fn();
    const end = performance.now();
    console.debug(`${name}: ${(end - start).toFixed(2)}ms`);
    return result;
}
}

    // ===== GLOBAL STATE MANAGER =====
    class AppState extends EventEmitter {
    constructor() {
    super();
    this.data = {
    db: null,
    player: null,
    currentChannel: null,
    channels: [],
    epgData: {},
    groups: [],
    filteredChannels: [],
    currentPage: 0,
    currentPlaylistUrl: null,
    searchQuery: '',
    selectedGroup: '',
    devicePerformance: Performance.detectLevel()
};

    this.caches = {
    render: new Cache(100),
    epg: new Cache(1000),
    timeparse: new Cache(1000),
    channelMatch: new Cache(CONFIG.MAX_CACHE_SIZE),
    currentProgram: new Cache(100)
};

    this.timers = {
    epgUpdate: null,
    cacheCleanup: null
};

    this.startCacheCleanup();
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

    startCacheCleanup() {
    this.timers.cacheCleanup = setInterval(() => {
    Object.values(this.caches).forEach(cache => {
    if (typeof cache.cleanup === 'function') {
    cache.cleanup();
}
});
}, 300000); // 5 minutes
}

    destroy() {
    Object.values(this.timers).forEach(timer => {
    if (timer) clearInterval(timer);
});
    this.clearCaches();
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

    request.onerror = (e) => reject(e.target.error);
});
}

    async store(storeName, data) {
    if (!this.db) throw new Error('Database not initialized');

    const transaction = this.db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    return new Promise((resolve, reject) => {
    const request = store.put(data);
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e.target.error);
});
}

    async get(storeName, key) {
    if (!this.db) return null;

    const transaction = this.db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
});
}

    async getAll(storeName) {
    if (!this.db) return [];

    const transaction = this.db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
});
}

    async clear(storeName) {
    if (!this.db) return;

    const transaction = this.db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    return new Promise((resolve, reject) => {
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e.target.error);
});
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
                transition: transform 0.3s ease-out, opacity 0.3s ease-out;
                display: flex;
                align-items: center;
                gap: 12px;
                position: relative;
            }

            .notification-popup.show {
                transform: translateX(0);
            }

            .notification-popup.success {
                border-left: 4px solid #4CAF50;
            }

            .notification-popup.error {
                border-left: 4px solid #f44336;
            }

            .notification-popup.info {
                border-left: 4px solid #2196F3;
            }

            .notification-icon {
                font-size: 24px;
                flex-shrink: 0;
            }

            .notification-icon.success { color: #4CAF50; }
            .notification-icon.error { color: #f44336; }
            .notification-icon.info { color: #2196F3; }

            .notification-content {
                flex: 1;
            }

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
                font-size: 20px;
                color: #999;
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

            @media (max-width: 600px) {
                #notification-container {
                    left: 10px;
                    right: 10px;
                    top: 10px;
                }

                .notification-popup {
                    min-width: auto;
                    max-width: 100%;
                }
            }
        `;
    document.head.appendChild(style);
}

    show(title, message, type = 'success', duration = CONFIG.NOTIFICATION_DURATION) {
    const notification = this.createNotification(title, message, type);
    this.container.appendChild(notification);

    requestAnimationFrame(() => {
    notification.classList.add('show');
});

    const closeNotification = () => {
    notification.classList.remove('show');
    setTimeout(() => {
    if (notification.parentNode) {
    notification.parentNode.removeChild(notification);
}
}, 300);
};

    const closeBtn = notification.querySelector('.notification-close');
    if (closeBtn) {
    closeBtn.addEventListener('click', closeNotification);
}

    if (duration > 0) {
    setTimeout(closeNotification, duration);
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

    // ===== TIME & TIMEZONE UTILITIES =====
    class TimeManager {
    constructor() {
    this.userOffset = -new Date().getTimezoneOffset() / 60;
    this.epgOffset = CONFIG.EPG_TIMEZONE_OFFSET;
    this.diff = this.userOffset - this.epgOffset;
    this.parseCache = new Cache(1000);
}

    parseEPGTime(timeStr) {
    if (this.parseCache.has(timeStr)) {
    return this.parseCache.get(timeStr);
}

    try {
    const year = parseInt(timeStr.substring(0, 4), 10);
    const month = parseInt(timeStr.substring(4, 6), 10) - 1;
    const day = parseInt(timeStr.substring(6, 8), 10);
    const hour = parseInt(timeStr.substring(8, 10), 10);
    const minute = parseInt(timeStr.substring(10, 12), 10);
    const second = parseInt(timeStr.substring(12, 14), 10) || 0;

    const epgDate = new Date(year, month, day, hour, minute, second);
    const adjustedTime = new Date(epgDate.getTime() + (this.diff * 60 * 60 * 1000));

    this.parseCache.set(timeStr, adjustedTime);
    return adjustedTime;
} catch (error) {
    const fallback = new Date();
    this.parseCache.set(timeStr, fallback);
    return fallback;
}
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
    return `
            <i class="fas fa-clock"></i>
            Ваш часовой пояс: ${userOffsetStr}
        `;
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
    this.programCache = new Cache(100);
    this.updateTimer = null;
}

    async load(forceRefresh = false) {
    if (!forceRefresh) {
    try {
    const cached = await this.db.get('epg', CONFIG.EPG_URL);
    if (cached?.timestamp && (Date.now() - cached.timestamp) < CONFIG.EPG_EXPIRY) {
    this.parseEPG(cached.data);
    this.emit('loaded', this.epgCache);
    return;
}
} catch (error) {
    console.warn('Cache load failed:', error);
}
}

    await this.fetchFromServer();
}

    async fetchFromServer() {
    try {
    const response = await fetch(CONFIG.EPG_URL);
    if (!response.ok) {
    throw new Error(`EPG fetch failed: ${response.status}`);
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
    try {
    const cached = await this.db.get('epg', CONFIG.EPG_URL);
    if (cached) {
    this.parseEPG(cached.data);
    this.emit('loaded', this.epgCache);
    this.emit('offline', 'Загружена из кэша (офлайн режим)');
} else {
    this.emit('error', error);
    throw error;
}
} catch (cacheError) {
    this.emit('error', error);
    throw error;
}
}
}

    parseEPG(xmlText) {
    this.epgCache = {};

    try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");

    // Parse channels
    const channels = xmlDoc.getElementsByTagName('channel');
    for (const channel of channels) {
    const id = channel.getAttribute('id');
    const displayNames = Array.from(channel.getElementsByTagName('display-name'))
    .map(el => el.textContent);
    const icon = channel.getElementsByTagName('icon')[0];

    this.epgCache[id] = {
    names: displayNames,
    icon: icon?.getAttribute('src'),
    programs: []
};
}

    // Parse programs
    const programs = xmlDoc.getElementsByTagName('programme');
    for (const program of programs) {
    const channelId = program.getAttribute('channel');
    const start = program.getAttribute('start');
    const stop = program.getAttribute('stop');
    const titleEl = program.getElementsByTagName('title')[0];
    const descEl = program.getElementsByTagName('desc')[0];

    if (this.epgCache[channelId]) {
    this.epgCache[channelId].programs.push({
    start,
    stop,
    title: titleEl?.textContent || 'Нет названия',
    desc: descEl?.textContent || ''
});
}
}

    // Sort programs by time
    Object.values(this.epgCache).forEach(channel => {
    channel.programs.sort((a, b) =>
    this.timeManager.parseEPGTime(a.start) - this.timeManager.parseEPGTime(b.start)
    );
});

} catch (error) {
    console.error('EPG parsing failed:', error);
    this.emit('error', error);
    throw error;
}
}

    findMatchingChannel(channelName) {
    if (!channelName) return null;

    if (this.matchCache.has(channelName)) {
    return this.matchCache.get(channelName);
}

    const result = this.performChannelMatch(channelName);
    this.matchCache.set(channelName, result);
    return result;
}

    performChannelMatch(channelName) {
    const specialChannels = new Map([
    ['россия 1', '984'], ['россия-1', '3000'], ['первый канал', '1'],
    ['нтв', '3'], ['тнт', '6'], ['пятница', '8'], ['рентв', '15'],
    ['стс', '16'], ['домашний', '17'], ['тв3', '18'], ['звезда', '20'],
    ['мир', '21'], ['тнт4', '22'], ['муз тв', '23']
    ]);

    // 1. Exact match
    for (const [channelId, data] of Object.entries(this.epgCache)) {
    if (data.names.some(name =>
    name.trim().toLowerCase() === channelName.trim().toLowerCase())) {
    return { channelId, ...data };
}
}

    // 2. Partial match
    const cleanName = channelName
    .replace(/\+[0-9]+\s*\([^)]+\)/g, '')
    .replace(/HD|FHD|UHD|4K/i, '')
    .replace(/[^a-zA-Zа-яА-Я0-9\s]/g, '')
    .trim()
    .toLowerCase();

    for (const [channelId, data] of Object.entries(this.epgCache)) {
    const epgNames = data.names.map(name =>
    name.replace(/[^a-zA-Zа-яА-Я0-9\s]/g, '').trim().toLowerCase()
    );

    if (epgNames.some(name =>
    name.includes(cleanName) || cleanName.includes(name))) {
    return { channelId, ...data };
}
}

    // 3. Special cases
    for (const [name, channelId] of specialChannels) {
    if (cleanName.includes(name) && this.epgCache[channelId]) {
    return { channelId, ...this.epgCache[channelId] };
}
}

    return null;
}

    getCurrentProgram(channelName, epgData) {
    if (!epgData?.programs?.length) {
    return 'Информация о программе недоступна';
}

    const cacheKey = `${channelName}_${Math.floor(Date.now() / 60000)}`;
    if (this.programCache.has(cacheKey)) {
    return this.programCache.get(cacheKey);
}

    const now = new Date();
    let result = 'Информация о программе недоступна';

    // Find current program
    for (const program of epgData.programs) {
    const startTime = this.timeManager.parseEPGTime(program.start);
    const endTime = this.timeManager.parseEPGTime(program.stop);

    if (now >= startTime && now <= endTime) {
    result = `${program.title} • до ${this.timeManager.formatTime(endTime)}`;
    break;
}
}

    // Find next program if no current
    if (result === 'Информация о программе недоступна') {
    for (const program of epgData.programs) {
    const startTime = this.timeManager.parseEPGTime(program.start);
    if (startTime > now) {
    result = `Далее: ${program.title} • в ${this.timeManager.formatTime(startTime)}`;
    break;
}
}
}

    this.programCache.set(cacheKey, result);
    return result;
}

    getProgressBar(epgData) {
    if (!epgData?.programs?.length) return '';

    const now = new Date();

    for (const program of epgData.programs) {
    const startTime = this.timeManager.parseEPGTime(program.start);
    const endTime = this.timeManager.parseEPGTime(program.stop);

    if (now >= startTime && now <= endTime) {
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
    const response = await fetch(url);
    if (!response.ok) {
    throw new Error(`Ошибка загрузки: ${response.status} ${response.statusText}`);
}
    const text = await response.text();
    return this.processPlaylist(text, url);
} catch (error) {
    this.emit('error', error);
    throw error;
}
}

    async loadFromFile(file) {
    try {
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
} catch (error) {
    this.emit('error', error);
    throw error;
}
}

    readFileAsText(file) {
    return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Ошибка чтения файла'));
    reader.onabort = () => reject(new Error('Чтение файла прервано'));
    reader.readAsText(file);
});
}

    async processPlaylist(playlistText, url) {
    await this.db.clear('playlists');
    await this.db.store('playlists', {
    url: url,
    data: playlistText,
    timestamp: Date.now()
});

    this.parseM3U8(playlistText);
    this.emit('loaded', { channels: this.channels, groups: this.groups });
}

    parseM3U8(text) {
    this.channels = [];
    this.groups = [];
    const groupSet = new Set();

    let currentChannel = null;
    const lines = text.split('\n');

    for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    try {
    if (trimmedLine.startsWith('#EXTINF:')) {
    currentChannel = this.parseExtinf(trimmedLine);
} else if (trimmedLine.startsWith('#EXTGRP:')) {
    if (currentChannel && !currentChannel.group) {
    currentChannel.group = trimmedLine.substring(8).trim();
}
} else if (this.isValidUrl(trimmedLine)) {
    if (currentChannel) {
    currentChannel.url = trimmedLine;
    if (currentChannel.group) {
    groupSet.add(currentChannel.group);
}
    this.channels.push(currentChannel);
    currentChannel = null;
}
}
} catch (error) {
    console.warn('Line parsing error:', error);
}
}

    this.groups = Array.from(groupSet).sort();
}

    parseExtinf(line) {
    const extinf = line.substring(8);
    const channel = {};

    // Find comma index outside quotes
    let commaIndex = -1;
    let inQuotes = false;

    for (let i = 0; i < extinf.length; i++) {
    if (extinf[i] === '"') {
    inQuotes = !inQuotes;
} else if (extinf[i] === ',' && !inQuotes) {
    commaIndex = i;
    break;
}
}

    if (commaIndex === -1) {
    channel.name = extinf.trim();
} else {
    const attributesStr = extinf.substring(0, commaIndex).trim();
    channel.name = extinf.substring(commaIndex + 1).trim();

    // Parse attributes
    const quotedAttrRegex = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g;
    let match;
    while ((match = quotedAttrRegex.exec(attributesStr)) !== null) {
    channel[match[1]] = match[2];
    if (match[1] === 'group-title') {
    channel.group = match[2];
}
}
}

    return channel;
}

    isValidUrl(url) {
    return url.match(/^(https?|rtmp|rtsp):\/\//i);
}
}

    // ===== RENDERER =====
    class ChannelRenderer {
    constructor(epgManager, appState) {
    this.epgManager = epgManager;
    this.appState = appState;
    this.elementPool = [];
    this.renderCache = new Cache(100);
}

    renderChannels(container, channels, filter = '', group = '') {
    const filteredChannels = this.filterChannels(channels, filter, group);

    if (filteredChannels.length === 0) {
    container.innerHTML = '<div class="no-results">Каналы не найдены</div>';
    return [];
}

    this.clearContainer(container);

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
    return channels.filter(channel => {
    const nameMatch = !filter || channel.name.toLowerCase().includes(filter.toLowerCase());
    const groupMatch = !group || channel.group === group;
    return nameMatch && groupMatch;
});
}

    clearContainer(container) {
    while (container.firstChild) {
    const child = container.firstChild;
    if (child.classList?.contains('channel-item')) {
    this.releaseElement(child);
}
    container.removeChild(child);
}
}

    renderBatch(container, channels) {
    requestAnimationFrame(() => {
    const fragment = document.createDocumentFragment();
    channels.forEach(channel => {
    const element = this.createChannelElement(channel);
    fragment.appendChild(element);
});
    container.appendChild(fragment);
});
}

    createChannelElement(channel) {
    const cacheKey = `${channel.url}_${Math.floor(Date.now() / 60000)}`;

    if (this.renderCache.has(cacheKey)) {
    const cached = this.renderCache.get(cacheKey);
    return this.createElement(channel, cached.html, cached.epgData);
}

    const epgData = this.epgManager.findMatchingChannel(channel.name);
    const currentProgram = this.epgManager.getCurrentProgram(channel.name, epgData);
    const progressBar = this.epgManager.getProgressBar(epgData);

    const html = `
            <img class="channel-logo" src="${epgData?.icon || '/css/no_logo.png'}" alt="${channel.name}"
                 onerror="this.src='/css/no_logo.png'">
            <div class="channel-info">
                <div class="channel-name">${channel.name}</div>
                <div class="channel-program">${currentProgram}</div>
                ${progressBar}
            </div>
        `;

    this.renderCache.set(cacheKey, { html, epgData });

    return this.createElement(channel, html, epgData);
}

    createElement(channel, html, epgData) {
    const element = this.getElement();
    element.innerHTML = html;
    element.dataset.url = channel.url;

    const currentChannel = this.appState.get('currentChannel');
    if (currentChannel?.url === channel.url) {
    element.classList.add('active');
}

    const clickHandler = () => this.appState.emit('channelSelected', { channel, epgData });
    element._clickHandler = clickHandler;
    element.addEventListener('click', clickHandler);

    return element;
}

    addLoadMoreButton(container, filteredChannels, currentCount) {
    const loadMoreBtn = document.createElement('div');
    loadMoreBtn.className = 'load-more-btn';
    loadMoreBtn.innerHTML = `<button class="btn">Показать еще (${filteredChannels.length - currentCount})</button>`;

    loadMoreBtn.addEventListener('click', () => {
    this.loadMore(container, filteredChannels, currentCount);
});

    container.appendChild(loadMoreBtn);
}

    loadMore(container, filteredChannels, currentCount) {
    const loadMoreBtn = container.querySelector('.load-more-btn');
    if (loadMoreBtn) {
    container.removeChild(loadMoreBtn);
}

    const performance = this.appState.get('devicePerformance');
    const batchSize = CONFIG.BATCH_SIZE[performance];
    const nextBatch = filteredChannels.slice(currentCount, currentCount + batchSize);

    this.renderBatch(container, nextBatch);

    const newCount = currentCount + batchSize;
    if (newCount < filteredChannels.length) {
    this.addLoadMoreButton(container, filteredChannels, newCount);
}
}

    getElement() {
    if (this.elementPool.length > 0) {
    return this.elementPool.pop();
}
    const element = document.createElement('div');
    element.className = 'channel-item';
    return element;
}

    releaseElement(element) {
    element.classList.remove('active');
    if (element._clickHandler) {
    element.removeEventListener('click', element._clickHandler);
    element._clickHandler = null;
}
    element.innerHTML = '';
    element.removeAttribute('data-url');
    this.elementPool.push(element);
}
}

    // ===== EPG RENDERER =====
    class EPGRenderer {
    constructor(timeManager) {
    this.timeManager = timeManager;
    this.elementPool = [];
}

    render(container, epgData) {
    if (!epgData?.programs?.length) {
    container.innerHTML = '<div class="no-results">Нет данных о программе</div>';
    return;
}

    requestAnimationFrame(() => {
    container.innerHTML = '<div class="epg-program-list"></div>';
    const programList = container.querySelector('.epg-program-list');

    const programs = this.getRelevantPrograms(epgData.programs);
    const fragment = document.createDocumentFragment();

    programs.forEach(program => {
    const element = this.createProgramElement(program);
    fragment.appendChild(element);
});

    programList.appendChild(fragment);
});
}

    getRelevantPrograms(programs) {
    const now = new Date();
    const relevantPrograms = [];
    let foundCurrent = false;

    for (const program of programs) {
    const startTime = this.timeManager.parseEPGTime(program.start);
    const endTime = this.timeManager.parseEPGTime(program.stop);

    if (endTime < now) continue;

    const programData = {
    ...program,
    startTime,
    endTime,
    isCurrent: !foundCurrent && startTime <= now && endTime >= now
};

    if (programData.isCurrent) {
    foundCurrent = true;
}

    relevantPrograms.push(programData);

    if (relevantPrograms.length >= 10) break;
}

    // Fallback to last programs if none found
    if (relevantPrograms.length === 0 && programs.length > 0) {
    const lastPrograms = programs.slice(-2);
    lastPrograms.forEach(program => {
    relevantPrograms.push({
    ...program,
    startTime: this.timeManager.parseEPGTime(program.start),
    endTime: this.timeManager.parseEPGTime(program.stop),
    isCurrent: false
});
});
}

    return relevantPrograms;
}

    createProgramElement(program) {
    const element = this.getElement();
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

    getElement() {
    if (this.elementPool.length > 0) {
    return this.elementPool.pop();
}
    return document.createElement('div');
}

    releaseElement(element) {
    element.className = '';
    element.innerHTML = '';
    element.title = '';
    this.elementPool.push(element);
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

    // Основные настройки для live трансляций
    live: true,
    autoPlay: true,
    online: true,
    syncUser: true,
    blocked: false,

    // Визуальные настройки
    theme: 'classic',
    aspectRatio: '16:9',
    title: channel.name,

    // Аудио и видео настройки
    volume: localStorage.getItem('playerVolume') || 0.8,

    // Буферизация для live потоков
    liveBuffer: 30,

    // Настройки интерфейса для TV трансляций
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

    // Источник с поддержкой аудио дорожек и субтитров
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

    // Оптимизированная конфигурация HLS для live потоков
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
    goLive: "Перейти к прямому эфиру",
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

    // Event handlers
    this.setupPlayerEventHandlers();

} catch (error) {
    console.error('VenomPlayer initialization failed:', error);
    this.createNativePlayer(container, channel);
}
}

    setupPlayerEventHandlers() {
    if (!this.currentPlayer) return;

    // Отслеживание доступных уровней качества
    this.currentPlayer.on('levelLoaded', (event, data) => {
    console.log('Level loaded:', data);
});

    this.currentPlayer.on('levelsUpdated', (event, data) => {
    console.log('Available quality levels updated:', data);
    if (data && data.levels) {
    data.levels.forEach((level, index) => {
    console.log(`Level ${index}:`, {
    width: level.width,
    height: level.height,
    bitrate: level.bitrate,
    name: level.name
});
});
}
});

    // Обработка ошибок и переподключения для live потоков
    this.currentPlayer.on('error', (error) => {
    console.warn('Live stream error:', error);
    setTimeout(() => {
    if (this.currentPlayer) {
    this.currentPlayer.load();
}
}, 5000);
});

    // Обработка готовности плеера
    this.currentPlayer.on('ready', () => {
    console.log('Live stream ready');

    if (this.currentPlayer.live) {
    this.currentPlayer.seekToLive();
}

    // Восстановление настроек
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

    // Обработка изменения качества
    this.currentPlayer.on('qualitychange', (event) => {
    const quality = event.level || event.quality;
    console.log('Quality changed to:', quality);

    if (quality && quality.height) {
    localStorage.setItem('preferredQuality', quality.height);
}
});

    // Обработка переключения аудиодорожек
    this.currentPlayer.on('audiochange', (audioTrack) => {
    console.log('Audio track changed to:', audioTrack);
    localStorage.setItem('preferredAudio', audioTrack);
});

    // Дополнительные настройки безопасности
    this.setupPlayerSecurity();
}

    setupPlayerSecurity() {
    setTimeout(() => {
    const playerElement = document.getElementById('player');
    if (playerElement) {
    // Отключение контекстного меню
    const disableContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    return false;
};

    playerElement.addEventListener('contextmenu', disableContextMenu, true);

    // Скрытие элементов брендинга
    this.hidePlayerBranding();

    // Блокировка горячих клавиш разработчика
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
    // Initialize core components
    this.components.appState = new AppState();
    this.components.database = new DatabaseManager();
    this.components.notifications = new NotificationManager();
    this.components.timeManager = new TimeManager();

    // Initialize database
    await this.components.database.init();
    this.components.appState.set('db', this.components.database);

    // Initialize managers
    this.components.epgManager = new EPGManager(
    this.components.database,
    this.components.timeManager
    );
    this.components.playlistManager = new PlaylistManager(this.components.database);
    this.components.playerManager = new PlayerManager(this.components.appState);

    // Initialize renderers
    this.components.channelRenderer = new ChannelRenderer(
    this.components.epgManager,
    this.components.appState
    );
    this.components.epgRenderer = new EPGRenderer(this.components.timeManager);

    // Setup event listeners
    this.setupEventListeners();

    // Initialize UI
    this.setupUI();

    // Load existing data
    await this.loadInitialData();

} catch (error) {
    this.components.notifications?.show('Ошибка инициализации', error.message, 'error');
    console.error('App initialization failed:', error);
}
}

    setupEventListeners() {
    const { appState, epgManager, playlistManager, playerManager, notifications } = this.components;

    // Playlist events
    this.subscribe(playlistManager, 'loaded', ({ channels, groups }) => {
    appState.update({ channels, groups });
    this.updateGroupFilter(groups);
    this.renderChannels();
    notifications.show('Плейлист загружен', `Загружено ${channels.length} каналов`, 'success');
});

    // EPG events
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
    this.updateVisibleChannelPrograms();
    const currentChannel = appState.get('currentChannel');
    if (currentChannel) {
    this.renderEPG(currentChannel.epgData);
}
});

    // Channel selection
    this.subscribe(appState, 'channelSelected', ({ channel, epgData }) => {
    playerManager.play(channel, epgData);
    this.renderEPG(epgData);
});

    // Error handling
    this.subscribe(epgManager, 'error', (error) => {
    notifications.show('Ошибка EPG', error.message, 'error');
});

    this.subscribe(playlistManager, 'error', (error) => {
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

    const closeBtn = dialog.querySelector('.dialog-close');
    const cancelBtn = document.getElementById('cancel-load-btn');
    const tabs = dialog.querySelectorAll('.dialog-tab');
    const fileInput = document.getElementById('playlist-file');
    const loadFileBtn = document.getElementById('load-file-btn');
    const loadUrlBtn = document.getElementById('load-url-btn');
    const loadDefaultBtn = document.getElementById('load-default-btn');
    const urlInput = document.getElementById('playlist-url');
    const fileNameDisplay = document.getElementById('file-name');

    const closeDialog = () => {
    dialog.classList.remove('active');
};

    const switchTab = (tabId) => {
    document.querySelectorAll('.dialog-content').forEach(content => {
    content.classList.remove('active');
});
    document.getElementById(tabId)?.classList.add('active');

    tabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabId);
});
};

    // Event listeners
    closeBtn?.addEventListener('click', closeDialog);
    cancelBtn?.addEventListener('click', closeDialog);

    tabs.forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

    if (fileInput && fileNameDisplay && loadFileBtn) {
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
    const fileStatus = document.getElementById('file-status');

    if (fileStatus) {
    fileStatus.textContent = 'Загрузка...';
    fileStatus.className = 'status-message';
}

    try {
    await this.components.playlistManager.loadFromFile(file);

    if (fileStatus) {
    fileStatus.textContent = 'Плейлист успешно загружен';
    fileStatus.className = 'status-message status-success';
}

    await this.components.epgManager.load();
    setTimeout(closeDialog, 1500);
} catch (error) {
    if (fileStatus) {
    fileStatus.textContent = 'Ошибка: ' + error.message;
    fileStatus.className = 'status-message status-error';
}
    this.components.notifications.show('Ошибка загрузки', error.message, 'error');
}
});
}

    if (loadUrlBtn && urlInput) {
    loadUrlBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    const urlStatus = document.getElementById('url-status');

    if (!url) {
    if (urlStatus) {
    urlStatus.textContent = 'Введите URL плейлиста';
    urlStatus.className = 'status-message status-error';
}
    return;
}

    try {
    new URL(url);
} catch (e) {
    if (urlStatus) {
    urlStatus.textContent = 'Введите корректный URL';
    urlStatus.className = 'status-message status-error';
}
    return;
}

    if (urlStatus) {
    urlStatus.textContent = 'Загрузка...';
    urlStatus.className = 'status-message';
}

    try {
    await this.components.playlistManager.loadFromUrl(url);

    if (urlStatus) {
    urlStatus.textContent = 'Плейлист успешно загружен';
    urlStatus.className = 'status-message status-success';
}

    await this.components.epgManager.load();
    setTimeout(closeDialog, 1500);
} catch (error) {
    if (urlStatus) {
    urlStatus.textContent = 'Ошибка: ' + error.message;
    urlStatus.className = 'status-message status-error';
}
    this.components.notifications.show('Ошибка загрузки', error.message, 'error');
}
});
}

    if (loadDefaultBtn) {
    loadDefaultBtn.addEventListener('click', async () => {
    const defaultStatus = document.getElementById('default-status');

    if (defaultStatus) {
    defaultStatus.textContent = 'Загрузка тестового плейлиста...';
    defaultStatus.className = 'status-message';
}

    try {
    await this.components.playlistManager.loadFromUrl(CONFIG.DEFAULT_PLAYLIST_URL);

    if (defaultStatus) {
    defaultStatus.textContent = 'Тестовый плейлист успешно загружен';
    defaultStatus.className = 'status-message status-success';
}

    await this.components.epgManager.load();
    setTimeout(closeDialog, 1500);
} catch (error) {
    if (defaultStatus) {
    defaultStatus.textContent = 'Ошибка: ' + error.message;
    defaultStatus.className = 'status-message status-error';
}
    this.components.notifications.show('Ошибка загрузки', error.message, 'error');
}
});
}

    // Store reference for external access
    this.showPlaylistDialog = () => {
    dialog.classList.add('active');

    // Reset status messages
    ['url-status', 'file-status', 'default-status'].forEach(id => {
    const element = document.getElementById(id);
    if (element) {
    element.className = 'status-message';
    element.textContent = '';
}
});

    // Reset inputs
    if (urlInput) urlInput.value = '';
    if (fileInput) fileInput.value = '';
    if (fileNameDisplay) fileNameDisplay.textContent = 'Файл не выбран';
    if (loadFileBtn) loadFileBtn.disabled = true;

    switchTab('url-tab');
};
}

    setupEpgDialog() {
    const dialog = document.getElementById('epg-dialog');
    if (!dialog) return;

    const closeBtn = dialog.querySelector('.dialog-close');
    const cancelBtn = document.getElementById('cancel-epg-btn');
    const refreshBtn = document.getElementById('refresh-epg-btn');
    const statusElement = document.getElementById('epg-status');

    const closeDialog = () => {
    dialog.classList.remove('active');
};

    closeBtn?.addEventListener('click', closeDialog);
    cancelBtn?.addEventListener('click', closeDialog);

    if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
    if (statusElement) {
    statusElement.textContent = 'Обновление EPG...';
    statusElement.className = 'status-message';
}

    try {
    await this.components.epgManager.refresh();

    if (statusElement) {
    statusElement.textContent = 'EPG успешно обновлен';
    statusElement.className = 'status-message status-success';
}

    this.renderChannels();

    // Update current channel EPG if playing
    const currentChannel = this.components.appState.get('currentChannel');
    if (currentChannel) {
    const epgData = this.components.epgManager.findMatchingChannel(currentChannel.name);
    this.renderEPG(epgData);
}

    setTimeout(closeDialog, 1500);
} catch (error) {
    if (statusElement) {
    statusElement.textContent = 'Ошибка: ' + error.message;
    statusElement.className = 'status-message status-error';
}
    this.components.notifications.show('Ошибка обновления', error.message, 'error');
}
});
}

    // Store reference for external access
    this.showEpgDialog = () => {
    dialog.classList.add('active');
    if (statusElement) {
    statusElement.className = 'status-message';
    statusElement.textContent = '';
}
};
}

    setupControls() {
    const searchInput = document.getElementById('search');
    const clearButton = document.querySelector('.search-clear');
    const groupFilter = document.getElementById('group-filter');
    const refreshEpgBtn = document.getElementById('refresh-epg');
    const loadNewPlaylistBtn = document.getElementById('load-new-playlist');

    if (searchInput) {
    const debouncedSearch = this.debounce((value) => {
    this.components.appState.set('searchQuery', value);
    this.renderChannels();
    if (clearButton) {
    clearButton.style.display = value ? 'block' : 'none';
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

    // EPG refresh button
    if (refreshEpgBtn) {
    refreshEpgBtn.addEventListener('click', () => this.showEpgDialog());
}

    // Load new playlist button
    if (loadNewPlaylistBtn) {
    loadNewPlaylistBtn.addEventListener('click', () => this.showPlaylistDialog());
}
}

    async loadInitialData() {
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
    // Show playlist dialog if it's available
    if (typeof this.showPlaylistDialog === 'function') {
    this.showPlaylistDialog();
}
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

    filter.innerHTML = '<option value="">Все группы</option>';
    groups.forEach(group => {
    const option = document.createElement('option');
    option.value = group;
    option.textContent = group;
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
}

    const progressContainer = item.querySelector('.channel-progress-container');
    if (progressContainer) {
    progressContainer.outerHTML = progressBar;
} else if (progressBar) {
    item.querySelector('.channel-info')?.insertAdjacentHTML('beforeend', progressBar);
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
    // Unsubscribe from all events
    this.eventUnsubscribers.forEach(unsubscribe => unsubscribe());

    // Destroy components
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

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
    if (window.iptvApp) {
    window.iptvApp.destroy();
}
});
