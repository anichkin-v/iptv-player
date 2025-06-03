
    // Глобальные переменные
    var db;
    var DB_NAME = 'IPTVDB';
    var DB_VERSION = 2;
    var venomPlayerInstance = null;
    var currentChannel = null;
    var channelsCache = [];
    var epgCache = {};
    var groupCache = [];
    var currentPlaylistUrl = null;
    var M3U8_EXPIRY = 365 * 24 * 60 * 60 * 1000; // 1 год
    var EPG_EXPIRY = 6 * 60 * 60 * 1000; // 6 часов

    // Константы для часовых поясов
    var EPG_TIMEZONE_OFFSET = -3; // Часовой пояс EPG (+3 UTC)
    var USER_TIMEZONE_OFFSET = -new Date().getTimezoneOffset() / 60; // Определяем часовой пояс пользователя
    var TIMEZONE_DIFF = USER_TIMEZONE_OFFSET - EPG_TIMEZONE_OFFSET; // Разница между поясом пользователя и EPG

    // Инициализация приложения
    document.addEventListener('DOMContentLoaded', function() {
    try {
    displayTimezone();
    setupEventListeners();
    setupDialog();

    initDB().then(function(dbInstance) {
    db = dbInstance;
    return getAllFromDB('playlists');
}).then(function(playlists) {
    if (playlists && playlists.length > 0) {
    currentPlaylistUrl = playlists[0].url;
    parseM3U8(playlists[0].data);
    return loadEPG();
} else {
    showPlaylistDialog();
}
}).then(function() {
    renderChannels();
}).catch(function(error) {
    console.error('Ошибка инициализации:', error);
    showError('Ошибка инициализации: ' + (error.message || error));
});
} catch (error) {
    console.error('Ошибка при загрузке:', error);
    showError('Критическая ошибка: ' + error.message);
}
});

    // Настройка диалогового окна
    function setupDialog() {
    const dialog = document.getElementById('playlist-dialog');
    const closeBtn = document.querySelector('.dialog-close');
    const cancelBtn = document.getElementById('cancel-load-btn');
    const tabs = document.querySelectorAll('.dialog-tab');
    const fileInput = document.getElementById('playlist-file');
    const loadFileBtn = document.getElementById('load-file-btn');
    const loadUrlBtn = document.getElementById('load-url-btn');
    const urlInput = document.getElementById('playlist-url');
    const fileNameDisplay = document.getElementById('file-name');

    // Закрытие диалога
    function closeDialog() {
    dialog.classList.remove('active');
}

    // Открытие диалога
    function showDialog() {
    dialog.classList.add('active');
    // Сброс состояний
    document.getElementById('url-status').className = 'status-message';
    document.getElementById('file-status').className = 'status-message';
    urlInput.value = '';
    fileInput.value = '';
    fileNameDisplay.textContent = 'Файл не выбран';
    loadFileBtn.disabled = true;
    // Активируем первую вкладку
    switchTab('url-tab');
}

    // Переключение вкладок
    function switchTab(tabId) {
    // Скрыть все вкладки
    document.querySelectorAll('.dialog-content').forEach(content => {
    content.classList.remove('active');
});
    // Показать выбранную вкладку
    document.getElementById(tabId).classList.add('active');

    // Обновить активные табы
    tabs.forEach(tab => {
    if (tab.dataset.tab === tabId) {
    tab.classList.add('active');
} else {
    tab.classList.remove('active');
}
});
}

    // Обработчики событий
    closeBtn.addEventListener('click', closeDialog);
    cancelBtn.addEventListener('click', closeDialog);

    tabs.forEach(tab => {
    tab.addEventListener('click', function() {
    switchTab(this.dataset.tab);
});
});

    fileInput.addEventListener('change', function() {
    if (this.files && this.files.length > 0) {
    fileNameDisplay.textContent = this.files[0].name;
    loadFileBtn.disabled = false;
} else {
    fileNameDisplay.textContent = 'Файл не выбран';
    loadFileBtn.disabled = true;
}
});

    loadFileBtn.addEventListener('click', function() {
    if (!fileInput.files || fileInput.files.length === 0) return;

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = function(e) {
    const playlistText = e.target.result;
    const fileStatus = document.getElementById('file-status');

    processPlaylist(playlistText, 'file_' + file.name)
    .then(() => {
    fileStatus.textContent = 'Плейлист успешно загружен';
    fileStatus.className = 'status-message status-success';
    setTimeout(closeDialog, 1500);
})
    .catch(error => {
    console.error('Ошибка загрузки файла:', error);
    fileStatus.textContent = 'Ошибка: ' + (error.message || error);
    fileStatus.className = 'status-message status-error';
});
};

    reader.onerror = function() {
    const fileStatus = document.getElementById('file-status');
    fileStatus.textContent = 'Ошибка чтения файла';
    fileStatus.className = 'status-message status-error';
};

    reader.readAsText(file);
});

    loadUrlBtn.addEventListener('click', function() {
    const url = urlInput.value.trim();
    const urlStatus = document.getElementById('url-status');

    if (!url) {
    urlStatus.textContent = 'Введите URL плейлиста';
    urlStatus.className = 'status-message status-error';
    return;
}

    urlStatus.textContent = 'Загрузка...';
    urlStatus.className = 'status-message';

    fetchPlaylistFromUrl(url)
    .then(() => {
    urlStatus.textContent = 'Плейлист успешно загружен';
    urlStatus.className = 'status-message status-success';
    setTimeout(closeDialog, 1500);
})
    .catch(error => {
    console.error('Ошибка загрузки URL:', error);
    urlStatus.textContent = 'Ошибка: ' + (error.message || error);
    urlStatus.className = 'status-message status-error';
});
});

    // Экспорт функции для показа диалога
    window.showPlaylistDialog = showDialog;
}

    // Показ часового пояса
    function displayTimezone() {
    try {
    var userOffset = USER_TIMEZONE_OFFSET;
    var userOffsetStr = (userOffset >= 0 ? '+' : '') + userOffset + ' UTC';

    var timezoneDisplay = document.getElementById('timezone-display');
    timezoneDisplay.innerHTML = '<i class="fas fa-clock"> Часовой пояс</i> ' + userOffsetStr +
    ' ';
} catch (e) {
    console.error("Ошибка при отображении часового пояса:", e);
}
}

    // Инициализация IndexedDB с обработкой версий
    function initDB() {
    return new Promise(function(resolve, reject) {
    var versionCheck = indexedDB.open(DB_NAME);

    versionCheck.onsuccess = function(event) {
    var tempDb = event.target.result;
    var currentVersion = tempDb.version;
    tempDb.close();

    if (currentVersion >= DB_VERSION) {
    var openRequest = indexedDB.open(DB_NAME, currentVersion);

    openRequest.onsuccess = function(event) {
    resolve(event.target.result);
};

    openRequest.onerror = function(event) {
    reject(event.target.error);
};
}
    else {
    var upgradeRequest = indexedDB.open(DB_NAME, DB_VERSION);

    upgradeRequest.onupgradeneeded = function(event) {
    var db = event.target.result;

    if (db.objectStoreNames.contains('playlists')) {
    db.deleteObjectStore('playlists');
}
    if (db.objectStoreNames.contains('epg')) {
    db.deleteObjectStore('epg');
}

    db.createObjectStore('playlists', { keyPath: 'url' });
    db.createObjectStore('epg', { keyPath: 'url' });
};

    upgradeRequest.onsuccess = function(event) {
    resolve(event.target.result);
};

    upgradeRequest.onerror = function(event) {
    reject(event.target.error);
};
}
};

    versionCheck.onerror = function(event) {
    var createRequest = indexedDB.open(DB_NAME, DB_VERSION);

    createRequest.onupgradeneeded = function(event) {
    var db = event.target.result;
    db.createObjectStore('playlists', { keyPath: 'url' });
    db.createObjectStore('epg', { keyPath: 'url' });
};

    createRequest.onsuccess = function(event) {
    resolve(event.target.result);
};

    createRequest.onerror = function(event) {
    reject(event.target.error);
};
};
});
}

    // Настройка обработчиков событий
    function setupEventListeners() {
    document.getElementById('search').addEventListener('input', function(e) {
        var filter = e.target.value;
        var groupFilter = document.getElementById('group-filter').value;
        renderChannels(filter, groupFilter);
    });

    document.getElementById('group-filter').addEventListener('change', function(e) {
    var group = e.target.value;
    var searchFilter = document.getElementById('search').value;
    renderChannels(searchFilter, group);
});

    document.getElementById('refresh-epg').addEventListener('click', function() {
    refreshEPG().catch(function(error) {
    console.error('Ошибка обновления EPG:', error);
    showError('Ошибка обновления EPG');
});
});

    document.getElementById('load-new-playlist').addEventListener('click', function() {
    showPlaylistDialog();
});
}

    // Показать сообщение об ошибке
    function showError(message) {
    alert(message); // В будущем можно заменить на красивый toast
}

    // Обновление EPG
    function refreshEPG() {
    return clearDB('epg').then(function() {
    return loadEPG(true);
}).then(function() {
    if (currentChannel) {
    var epgData = findMatchingEPG(currentChannel.name);
    renderEPG(epgData);
}
    renderChannels();
    showError('EPG обновлен');
});
}

    // Загрузка плейлиста по URL
    function fetchPlaylistFromUrl(url) {
    return fetch(url).then(function(response) {
    if (!response.ok) throw new Error('Ошибка загрузки: ' + response.status);
    return response.text();
}).then(function(text) {
    currentPlaylistUrl = url;
    return processPlaylist(text, url);
});
}

    // Обработка плейлиста
    function processPlaylist(playlistText, url) {
    return clearDB('playlists').then(function() {
    return storeInDB('playlists', {
    url: url || currentPlaylistUrl,
    data: playlistText,
    timestamp: Date.now()
});
}).then(function() {
    parseM3U8(playlistText);
    return loadEPG();
}).then(function() {
    renderChannels();
});
}

    // Парсинг M3U8
    function parseM3U8(text) {
    channelsCache = [];
    groupCache = [];

    var lines = text.split('\n');
    var currentChannel = null;

    for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();

    if (line.startsWith('#EXTINF:')) {
    currentChannel = {};

    var params = line.substring(8).split(',');
    var attributes = params[0].trim();
    currentChannel.name = params.slice(1).join(',').trim();

    var attrRegex = /([a-z-]+)="([^"]+)"/g;
    var match;
    while ((match = attrRegex.exec(attributes))) {
    currentChannel[match[1]] = match[2];
}
}
    else if (line.startsWith('#EXTGRP:')) {
    if (currentChannel) {
    currentChannel.group = line.substring(8).trim();
    if (groupCache.indexOf(currentChannel.group) === -1) {
    groupCache.push(currentChannel.group);
}
}
}
    else if (line.startsWith('http')) {
    if (currentChannel) {
    currentChannel.url = line.trim();
    channelsCache.push(currentChannel);
    currentChannel = null;
}
}
}

    updateGroupFilter();
}

    // Обновление фильтра групп
    function updateGroupFilter() {
    var filter = document.getElementById('group-filter');
    filter.innerHTML = '<option value="">Все группы</option>';

    groupCache.sort(function(a, b) {
    return a.localeCompare(b);
});

    groupCache.forEach(function(group) {
    var option = document.createElement('option');
    option.value = group;
    option.textContent = group;
    filter.appendChild(option);
});
}

    // Загрузка EPG
    function loadEPG(forceRefresh) {
    var epgUrl = 'http://epg.one/epg2.xml';

    if (!forceRefresh) {
    return getFromDB('epg', epgUrl).then(function(cached) {
    if (cached && cached.timestamp && (Date.now() - cached.timestamp) < EPG_EXPIRY) {
    parseEPG(cached.data);
    return;
}
    return fetchEPG(epgUrl);
}).catch(function() {
    return fetchEPG(epgUrl);
});
} else {
    return fetchEPG(epgUrl);
}
}

    // Загрузка EPG с сервера
    function fetchEPG(epgUrl) {
    return fetch(epgUrl).then(function(response) {
    if (!response.ok) throw new Error('Ошибка EPG: ' + response.status);
    return response.text();
}).then(function(text) {
    return storeInDB('epg', {
    url: epgUrl,
    data: text,
    timestamp: Date.now()
}).then(function() {
    parseEPG(text);
});
}).catch(function(error) {
    console.error('Ошибка загрузки EPG:', error);
    return getFromDB('epg', epgUrl).then(function(cached) {
    if (cached) {
    parseEPG(cached.data);
} else {
    throw error;
}
});
});
}

    // Парсинг EPG XML с учетом часовых поясов
    function parseEPG(xmlText) {
    epgCache = {};

    try {
    var parser = new DOMParser();
    var xmlDoc = parser.parseFromString(xmlText, "text/xml");

    // Парсим каналы
    var channels = xmlDoc.getElementsByTagName('channel');
    for (var i = 0; i < channels.length; i++) {
    var channel = channels[i];
    var id = channel.getAttribute('id');
    var displayNames = channel.getElementsByTagName('display-name');
    var icon = channel.getElementsByTagName('icon')[0];

    var names = [];
    for (var j = 0; j < displayNames.length; j++) {
    names.push(displayNames[j].textContent);
}

    epgCache[id] = {
    names: names,
    icon: icon ? icon.getAttribute('src') : null,
    programs: []
};
}

    // Парсим программы с учетом разницы часовых поясов
    var programs = xmlDoc.getElementsByTagName('programme');
    for (var k = 0; k < programs.length; k++) {
    var program = programs[k];
    var channelId = program.getAttribute('channel');
    var start = program.getAttribute('start');
    var stop = program.getAttribute('stop');
    var titleEl = program.getElementsByTagName('title')[0];
    var descEl = program.getElementsByTagName('desc')[0];

    var title = titleEl ? titleEl.textContent : 'Нет названия';
    var desc = descEl ? descEl.textContent : '';

    if (epgCache[channelId]) {
    epgCache[channelId].programs.push({
    start: start,
    stop: stop,
    title: title,
    desc: desc
});
}
}

    // Сортируем программы по времени
    for (var channelId in epgCache) {
    if (epgCache.hasOwnProperty(channelId)) {
    epgCache[channelId].programs.sort(function(a, b) {
    return parseEPGTime(a.start) - parseEPGTime(b.start);
});
}
}
} catch (error) {
    console.error('Ошибка парсинга EPG:', error);
    throw error;
}
}

    // Отображение списка каналов
    function renderChannels(filter, group) {
    var container = document.getElementById('channels-list');
    if (!container) return;

    container.innerHTML = '';

    filter = filter || '';
    group = group || '';

    var filteredChannels = channelsCache.filter(function(channel) {
    var nameMatch = channel.name.toLowerCase().indexOf(filter.toLowerCase()) !== -1;
    var groupMatch = !group || channel.group === group;
    return nameMatch && groupMatch;
});

    if (filteredChannels.length === 0) {
    container.innerHTML = '<div class="no-results">Каналы не найдены</div>';
    return;
}

    filteredChannels.forEach(function(channel) {
    var channelElement = document.createElement('div');
    channelElement.className = 'channel-item';
    if (currentChannel && currentChannel.url === channel.url) {
    channelElement.classList.add('active');
}
    channelElement.dataset.url = channel.url;

    var epgData = findMatchingEPG(channel.name);
    var currentProgram = getCurrentProgram(epgData);
    var progressBar = renderChannelProgressBar(epgData);

    channelElement.innerHTML = [
    '<img class="channel-logo" src="', (epgData && epgData.icon) || 'no_logo.png', '" alt="', channel.name,
    '" onerror="this.src=\'/css/no_logo.png\'">',
    '<div class="channel-info">',
    '<div class="channel-name">', channel.name, '</div>',
    '<div class="channel-program">', currentProgram, '</div>',
    progressBar,
    '</div>'
    ].join('');

    channelElement.addEventListener('click', function() {
    playChannel(channel, epgData);
});

    container.appendChild(channelElement);
});
}

    // Поиск соответствия EPG для канала
    function findMatchingEPG(channelName) {
    if (!channelName) return null;

    // 1. Точное совпадение
    for (var channelId in epgCache) {
    if (epgCache.hasOwnProperty(channelId)) {
    var epgNames = epgCache[channelId].names;
    for (var i = 0; i < epgNames.length; i++) {
    if (epgNames[i].trim().toLowerCase() === channelName.trim().toLowerCase()) {
    return {
    channelId: channelId,
    icon: epgCache[channelId].icon,
    programs: epgCache[channelId].programs
};
}
}
}
}

    // 2. Очистка имени и поиск частичного совпадения
    var cleanChannelName = channelName
    .replace(/\+[0-9]+\s*\([^)]+\)/g, '')
    .replace(/HD|FHD|UHD|4K/i, '')
    .replace(/[^a-zA-Zа-яА-Я0-9\s]/g, '')
    .trim()
    .toLowerCase();

    for (var channelId in epgCache) {
    if (epgCache.hasOwnProperty(channelId)) {
    var epgNames = epgCache[channelId].names.map(function(name) {
    return name.replace(/[^a-zA-Zа-яА-Я0-9\s]/g, '')
    .trim()
    .toLowerCase();
});

    for (var j = 0; j < epgNames.length; j++) {
    if (epgNames[j].indexOf(cleanChannelName) !== -1 ||
    cleanChannelName.indexOf(epgNames[j]) !== -1) {
    return {
    channelId: channelId,
    icon: epgCache[channelId].icon,
    programs: epgCache[channelId].programs
};
}
}
}
}

    // 3. Специальные случаи для популярных каналов
    var specialCases = {
    'Россия 1':'984',
    'россия 1': '984',
    'россия-1': '984',
    'первый канал': '1',
    'нтв': '3',
    'тнт': '6',
    'пятница': '8',
    'рентв': '15',
    'стс': '16',
    'домашний': '17',
    'тв3': '18',
    'пятница': '19',
    'звезда': '20',
    'мир': '21',
    'тнт4': '22',
    'муз тв': '23'
};

    for (var name in specialCases) {
    if (specialCases.hasOwnProperty(name) && cleanChannelName.indexOf(name) !== -1) {
    var channelId = specialCases[name];
    if (epgCache[channelId]) {
    return {
    channelId: channelId,
    icon: epgCache[channelId].icon,
    programs: epgCache[channelId].programs
};
}
}
}

    return null;
}

    // Получение текущей программы с учетом часовых поясов
    function getCurrentProgram(epgData) {
    if (!epgData || !epgData.programs || epgData.programs.length === 0) {
    return 'Нет данных';
}

    var now = new Date();

    for (var i = 0; i < epgData.programs.length; i++) {
    var program = epgData.programs[i];
    var startTime = parseEPGTime(program.start);
    var endTime = parseEPGTime(program.stop);

    // Корректируем время с учетом разницы часовых поясов
    var adjustedStartTime = new Date(startTime.getTime() );
    var adjustedEndTime = new Date(endTime.getTime() );

    if (now >= adjustedStartTime && now <= adjustedEndTime) {
    var endTimeStr = formatTime(adjustedEndTime);
    return program.title + ' • до ' + endTimeStr;
}
}

    return 'Нет данных';
}

    // Форматирование времени
    function formatTime(date) {
    var hours = date.getHours();
    var minutes = date.getMinutes();
    return (hours < 10 ? '0' : '') + hours + ':' + (minutes < 10 ? '0' : '') + minutes;
}

    // Парсинг времени EPG с учетом часового пояса EPG
    function parseEPGTime(timeStr) {
    var year = parseInt(timeStr.substr(0, 4), 10);
    var month = parseInt(timeStr.substr(4, 2), 10) - 1;
    var day = parseInt(timeStr.substr(6, 2), 10);
    var hour = parseInt(timeStr.substr(8, 2), 10);
    var minute = parseInt(timeStr.substr(10, 2), 10);
    var second = parseInt(timeStr.substr(12, 2), 10) || 0;

    // Создаем дату в часовом поясе EPG (+3 UTC)
    var date = new Date(Date.UTC(year, month, day, hour, minute, second));

    // Корректируем на разницу между поясом EPG и UTC
    date.setMinutes(date.getMinutes() + EPG_TIMEZONE_OFFSET * 60);

    return date;
}

    // Рендеринг прогресс-бара с учетом часовых поясов
    function renderChannelProgressBar(epgData) {
    if (!epgData || !epgData.programs || epgData.programs.length === 0) {
    return '';
}

    const now = new Date();
    let currentProgram = null;
    let progress = 0;

    for (const program of epgData.programs) {
    const startTime = parseEPGTime(program.start);
    const endTime = parseEPGTime(program.stop);

    // Корректируем время с учетом разницы часовых поясов
    const adjustedStartTime = new Date(startTime.getTime() + TIMEZONE_DIFF * 60 * 60 * 1000);
    const adjustedEndTime = new Date(endTime.getTime() + TIMEZONE_DIFF * 60 * 60 * 1000);

    if (now >= adjustedStartTime && now <= adjustedEndTime) {
    currentProgram = program;
    const programDuration = adjustedEndTime - adjustedStartTime;
    const elapsedTime = now - adjustedStartTime;
    progress = Math.min(100, Math.max(0, (elapsedTime / programDuration) * 100));
    break;
}
}

    if (!currentProgram) {
    return '';
}

    return '<div class="channel-progress-container">' +
    '<div class="channel-progress-bar" style="width:' + progress + '%"></div>' +
    '</div>';
}

    // Воспроизведение канала
    function playChannel(channel, epgData) {
    currentChannel = {
        name: channel.name,
        url: channel.url,
        group: channel.group,
        epgData: epgData
    };

    var channelElements = document.querySelectorAll('.channel-item');
    for (var i = 0; i < channelElements.length; i++) {
    channelElements[i].classList.remove('active');
    if (channelElements[i].dataset.url === channel.url) {
    channelElements[i].classList.add('active');
}
}

    var playerContainer = document.getElementById('player-container');
    playerContainer.innerHTML = '<div id="player"></div>';

    if (venomPlayerInstance) {
    try {
    venomPlayerInstance.destroy();
} catch (e) {
    console.error('Ошибка уничтожения плеера:', e);
}
}

    if (!window.VenomPlayer || typeof VenomPlayer.make !== 'function') {
    playerContainer.innerHTML = [
    '<video controls autoplay style="width:100%;height:100%;background:#000;">',
    '<source src="', channel.url, '" type="application/x-mpegURL">',
    'Ваш браузер не поддерживает видео элемент.',
    '</video>'
    ].join('');
    renderEPG(epgData);
    return;
}

    try {
    venomPlayerInstance = VenomPlayer.make({
    container: document.getElementById('player'),
    publicPath: './dist/',
    syncUser: true,
    blocked: false,
    theme: 'classic',
    aspectRatio: '16:9',
    autoPlay: true,
    volume: localStorage.getItem('playerVolume') || 1,
    online: true,
    live: true,
    title: channel.name,
    ui: {
    prevNext: false,
    share: false,
    airplay: true,
    pip: true,
    mini: true,
    about: false,
    copyUrl: false,
    copyWithTime: false,
    viewProgress: false
},
    source: {
    hls: channel.url,
    type: 'application/x-mpegURL'
},
    quality: function (q) {
    if (q > 2000) return q + 'K';
    if (q > 1079) return 'fHD ' + q;
    if (q > 719) return 'HD ' + q;
    return q;
},
    hlsConfig: {
    maxBufferLength: 420,
    maxBufferSize: 20 * 1024 * 1024,
    liveSyncDuration: 60,
    liveMaxLatencyDuration: 30,
    lowLatencyMode: true
}
});

    // Обновляем EPG
    renderEPG(epgData);
} catch (error) {
    console.error('Ошибка инициализации плеера:', error);
    playerContainer.innerHTML = '<div class="error">Ошибка загрузки плеера</div>';
}
}

    // Отображение EPG
    function renderEPG(epgData) {
    var container = document.getElementById('epg-container');
    if (!container) return;

    if (!epgData || !epgData.programs || epgData.programs.length === 0) {
    container.innerHTML = '<div class="no-results">Нет данных о программе</div>';
    return;
}

    container.innerHTML = '<div class="epg-program-list"></div>';
    var programList = container.querySelector('.epg-program-list');
    var now = new Date();

    // Показываем текущую программу и следующие 5 программ
    var programsToShow = [];
    var foundCurrent = false;

    for (var i = 0; i < epgData.programs.length; i++) {
    var program = epgData.programs[i];
    var startTime = parseEPGTime(program.start);
    var endTime = parseEPGTime(program.stop);

    if (endTime < now) continue; // Пропускаем прошедшие программы

    if (!foundCurrent && startTime <= now) {
    // Текущая программа
    program.isCurrent = true;
    programsToShow.push(program);
    foundCurrent = true;
} else {
    // Будущие программы
    program.isCurrent = false;
    programsToShow.push(program);
}

    // Ограничиваем количество программ
    if (programsToShow.length >= (foundCurrent ? 10 : 10)) break;
}

    if (programsToShow.length === 0) {
    // Нет текущих или будущих программ, показываем последнюю программу
    for (var j = epgData.programs.length - 1; j >= 0; j--) {
    var lastProgram = epgData.programs[j];
    var endTime = parseEPGTime(lastProgram.stop);

    if (endTime < now) {
    lastProgram.isCurrent = false;
    programsToShow.push(lastProgram);
    break;
}
}
}

    // Рендерим программы
    programsToShow.forEach(function(program) {
    var programElement = document.createElement('div');
    programElement.className = 'epg-program-item';
    if (program.isCurrent) {
    programElement.classList.add('current-program');
}

    var startTime = parseEPGTime(program.start);
    var endTime = parseEPGTime(program.stop);

    programElement.innerHTML = [
    '<div class="epg-program-time">', formatTime(startTime), ' - ', formatTime(endTime), '</div>',
    '<div class="epg-program-title">', program.title, '</div>'
    ].join('');

    // Добавляем описание как подсказку
    if (program.desc) {
    programElement.title = program.desc;
}

    programList.appendChild(programElement);
});
}

    // IndexedDB helpers
    function storeInDB(storeName, data) {
    return new Promise(function(resolve, reject) {
    var transaction = db.transaction(storeName, 'readwrite');
    var store = transaction.objectStore(storeName);
    var request = store.put(data);

    request.onsuccess = function() { resolve(); };
    request.onerror = function(event) { reject(event.target.error); };
});
}

    function getFromDB(storeName, key) {
    return new Promise(function(resolve, reject) {
    var transaction = db.transaction(storeName, 'readonly');
    var store = transaction.objectStore(storeName);
    var request = store.get(key);

    request.onsuccess = function() { resolve(request.result); };
    request.onerror = function(event) { reject(event.target.error); };
});
}

    function getAllFromDB(storeName) {
    return new Promise(function(resolve, reject) {
    var transaction = db.transaction(storeName, 'readonly');
    var store = transaction.objectStore(storeName);
    var request = store.getAll();

    request.onsuccess = function() { resolve(request.result); };
    request.onerror = function(event) { reject(event.target.error); };
});
}

    function clearDB(storeName) {
    return new Promise(function(resolve, reject) {
    var transaction = db.transaction(storeName, 'readwrite');
    var store = transaction.objectStore(storeName);
    var request = store.clear();

    request.onsuccess = function() { resolve(); };
    request.onerror = function(event) { reject(event.target.error); };
});
}
