   // Глобальные переменные
    const DB_NAME = 'IPTVDB';
    const DB_VERSION = 2;
    const M3U8_EXPIRY = 365 * 24 * 60 * 60 * 1000; // 1 год
    const EPG_EXPIRY = 6 * 60 * 60 * 1000; // 6 часов
    const EPG_TIMEZONE_OFFSET = -3; // Часовой пояс EPG (+3 UTC)

    let db;
    let venomPlayerInstance = null;
    let currentChannel = null;
    let channelsCache = [];
    let epgCache = {};
    let groupCache = [];
    let currentPlaylistUrl = null;

    // Часовые пояса
    const USER_TIMEZONE_OFFSET = -new Date().getTimezoneOffset() / 60;
    const TIMEZONE_DIFF = USER_TIMEZONE_OFFSET - EPG_TIMEZONE_OFFSET;

    // Специальные случаи для популярных каналов
    const SPECIAL_CHANNELS = {
        'Россия 1': '984',
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

    // Инициализация приложения
    document.addEventListener('DOMContentLoaded', async function() {
        try {
            displayTimezone();
            setupDialog();
            setupEventListeners();

            db = await initDB();
            const playlists = await getAllFromDB('playlists');

            if (playlists?.length > 0) {
                currentPlaylistUrl = playlists[0].url;
                parseM3U8(playlists[0].data);
                await loadEPG();
                renderChannels();
            } else {
                showPlaylistDialog();
            }
        } catch (error) {
            console.error('Ошибка инициализации:', error);
            showError('Критическая ошибка: ' + error.message);
        }
    });

    // Настройка диалогового окна
    function setupDialog() {
        const dialog = document.getElementById('playlist-dialog');
        const closeBtn = dialog.querySelector('.dialog-close');
        const cancelBtn = document.getElementById('cancel-load-btn');
        const tabs = dialog.querySelectorAll('.dialog-tab');
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
        window.showPlaylistDialog = function() {
            dialog.classList.add('active');
            // Сброс состояний
            document.getElementById('url-status').className = 'status-message';
            document.getElementById('file-status').className = 'status-message';
            urlInput.value = '';
            fileInput.value = '';
            fileNameDisplay.textContent = 'Файл не выбран';
            loadFileBtn.disabled = true;
            switchTab('url-tab');
        };

        // Переключение вкладок
        function switchTab(tabId) {
            document.querySelectorAll('.dialog-content').forEach(content => {
                content.classList.remove('active');
            });
            document.getElementById(tabId).classList.add('active');

            tabs.forEach(tab => {
                tab.classList.toggle('active', tab.dataset.tab === tabId);
            });
        }

        // Обработчики событий
        closeBtn.addEventListener('click', closeDialog);
        cancelBtn.addEventListener('click', closeDialog);

        tabs.forEach(tab => {
            tab.addEventListener('click', () => switchTab(tab.dataset.tab));
        });

        fileInput.addEventListener('change', function() {
            if (this.files?.length > 0) {
                fileNameDisplay.textContent = this.files[0].name;
                loadFileBtn.disabled = false;
            } else {
                fileNameDisplay.textContent = 'Файл не выбран';
                loadFileBtn.disabled = true;
            }
        });

        loadFileBtn.addEventListener('click', async function() {
            if (!fileInput.files?.length) return;

            const file = fileInput.files[0];
            const fileStatus = document.getElementById('file-status');

            try {
                const playlistText = await readFileAsText(file);
                await processPlaylist(playlistText, 'file_' + file.name);

                fileStatus.textContent = 'Плейлист успешно загружен';
                fileStatus.className = 'status-message status-success';
                setTimeout(closeDialog, 1500);
            } catch (error) {
                console.error('Ошибка загрузки файла:', error);
                fileStatus.textContent = 'Ошибка: ' + (error.message || error);
                fileStatus.className = 'status-message status-error';
            }
        });

        loadUrlBtn.addEventListener('click', async function() {
            const url = urlInput.value.trim();
            const urlStatus = document.getElementById('url-status');

            if (!url) {
                urlStatus.textContent = 'Введите URL плейлиста';
                urlStatus.className = 'status-message status-error';
                return;
            }

            urlStatus.textContent = 'Загрузка...';
            urlStatus.className = 'status-message';

            try {
                await fetchPlaylistFromUrl(url);
                urlStatus.textContent = 'Плейлист успешно загружен';
                urlStatus.className = 'status-message status-success';
                setTimeout(closeDialog, 1500);
            } catch (error) {
                console.error('Ошибка загрузки URL:', error);
                urlStatus.textContent = 'Ошибка: ' + (error.message || error);
                urlStatus.className = 'status-message status-error';
            }
        });
    }

    // Вспомогательная функция для чтения файла
    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = () => reject(new Error('Ошибка чтения файла'));
            reader.readAsText(file);
        });
    }

    // Настройка обработчиков событий
    function setupEventListeners() {
        const searchInput = document.getElementById('search');
        const clearButton = document.querySelector('.search-clear');
        const groupFilter = document.getElementById('group-filter');
        const refreshEpgBtn = document.getElementById('refresh-epg');
        const loadNewPlaylistBtn = document.getElementById('load-new-playlist');

        // Обработчик ввода текста
        searchInput.addEventListener('input', function(e) {
            const filter = e.target.value;
            const groupFilterValue = groupFilter.value;
            renderChannels(filter, groupFilterValue);
            clearButton.style.display = filter ? 'block' : 'none';
        });

        // Обработчик клика по крестику
        clearButton.addEventListener('click', function() {
            searchInput.value = '';
            clearButton.style.display = 'none';
            renderChannels('', groupFilter.value);
            searchInput.focus();
        });

        // Обработчик изменения группы
        groupFilter.addEventListener('change', function(e) {
            renderChannels(searchInput.value, e.target.value);
        });

        // Обновление EPG
        refreshEpgBtn.addEventListener('click', async function() {
            try {
                await refreshEPG();
            } catch (error) {
                console.error('Ошибка обновления EPG:', error);
                showError('Ошибка обновления EPG');
            }
        });

        // Загрузка нового плейлиста
        loadNewPlaylistBtn.addEventListener('click', showPlaylistDialog);
    }

    // Показ часового пояса
    function displayTimezone() {
        try {
            const userOffsetStr = (USER_TIMEZONE_OFFSET >= 0 ? '+' : '') + USER_TIMEZONE_OFFSET + ' UTC';
            const timezoneDisplay = document.getElementById('timezone-display');
            timezoneDisplay.innerHTML = `<i class="fas fa-clock"> Часовой пояс</i> ${userOffsetStr} `;
        } catch (e) {
            console.error("Ошибка при отображении часового пояса:", e);
        }
    }

    // Инициализация IndexedDB
    function initDB() {
        return new Promise((resolve, reject) => {
            // Проверяем текущую версию базы данных
            const versionCheck = indexedDB.open(DB_NAME);

            versionCheck.onsuccess = function(event) {
                const tempDb = event.target.result;
                const currentVersion = tempDb.version;
                tempDb.close();

                if (currentVersion >= DB_VERSION) {
                    // Используем существующую версию
                    const openRequest = indexedDB.open(DB_NAME, currentVersion);
                    openRequest.onsuccess = e => resolve(e.target.result);
                    openRequest.onerror = e => reject(e.target.error);
                } else {
                    // Обновляем базу данных
                    const upgradeRequest = indexedDB.open(DB_NAME, DB_VERSION);

                    upgradeRequest.onupgradeneeded = function(event) {
                        const db = event.target.result;

                        // Удаляем старые хранилища, если они существуют
                        ['playlists', 'epg'].forEach(storeName => {
                            if (db.objectStoreNames.contains(storeName)) {
                                db.deleteObjectStore(storeName);
                            }
                        });

                        // Создаем новые хранилища
                        db.createObjectStore('playlists', { keyPath: 'url' });
                        db.createObjectStore('epg', { keyPath: 'url' });
                    };

                    upgradeRequest.onsuccess = e => resolve(e.target.result);
                    upgradeRequest.onerror = e => reject(e.target.error);
                }
            };

            versionCheck.onerror = function() {
                // Создаем новую базу данных
                const createRequest = indexedDB.open(DB_NAME, DB_VERSION);

                createRequest.onupgradeneeded = function(event) {
                    const db = event.target.result;
                    db.createObjectStore('playlists', { keyPath: 'url' });
                    db.createObjectStore('epg', { keyPath: 'url' });
                };

                createRequest.onsuccess = e => resolve(e.target.result);
                createRequest.onerror = e => reject(e.target.error);
            };
        });
    }

    // Показать сообщение об ошибке
    function showError(message) {
        alert(message); // В будущем можно заменить на красивый toast
    }

    // Обновление EPG
    async function refreshEPG() {
        await clearDB('epg');
        await loadEPG(true);

        if (currentChannel) {
            const epgData = findMatchingEPG(currentChannel.name);
            renderEPG(epgData);
        }

        renderChannels();
        showError('EPG обновлен');
    }

    // Загрузка плейлиста по URL
    async function fetchPlaylistFromUrl(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Ошибка загрузки: ' + response.status);

        const text = await response.text();
        currentPlaylistUrl = url;
        return processPlaylist(text, url);
    }

    // Обработка плейлиста
    async function processPlaylist(playlistText, url) {
        await clearDB('playlists');
        await storeInDB('playlists', {
            url: url || currentPlaylistUrl,
            data: playlistText,
            timestamp: Date.now()
        });

        parseM3U8(playlistText);
        await loadEPG();
        renderChannels();
    }

    // Парсинг M3U8
    function parseM3U8(text) {
        channelsCache = [];
        groupCache = [];
        let currentChannel = null;

        const lines = text.split('\n');

        for (const line of lines) {
            const trimmedLine = line.trim();

            if (trimmedLine.startsWith('#EXTINF:')) {
                currentChannel = {};
                const params = trimmedLine.substring(8).split(',');
                const attributes = params[0].trim();
                currentChannel.name = params.slice(1).join(',').trim();

                // Парсинг атрибутов
                const attrRegex = /([a-z-]+)="([^"]+)"/g;
                let match;
                while ((match = attrRegex.exec(attributes))) {
                    currentChannel[match[1]] = match[2];
                }
            }
            else if (trimmedLine.startsWith('#EXTGRP:')) {
                if (currentChannel) {
                    currentChannel.group = trimmedLine.substring(8).trim();
                    if (!groupCache.includes(currentChannel.group)) {
                        groupCache.push(currentChannel.group);
                    }
                }
            }
            else if (trimmedLine.startsWith('http')) {
                if (currentChannel) {
                    currentChannel.url = trimmedLine;
                    channelsCache.push(currentChannel);
                    currentChannel = null;
                }
            }
        }

        updateGroupFilter();
    }

    // Обновление фильтра групп
    function updateGroupFilter() {
        const filter = document.getElementById('group-filter');
        filter.innerHTML = '<option value="">Все группы</option>';

        groupCache.sort((a, b) => a.localeCompare(b));

        groupCache.forEach(group => {
            const option = document.createElement('option');
            option.value = group;
            option.textContent = group;
            filter.appendChild(option);
        });
    }

    // Загрузка EPG
    async function loadEPG(forceRefresh = false) {
        const epgUrl = 'http://epg.one/epg2.xml';

        if (!forceRefresh) {
            try {
                const cached = await getFromDB('epg', epgUrl);
                if (cached?.timestamp && (Date.now() - cached.timestamp) < EPG_EXPIRY) {
                    parseEPG(cached.data);
                    return;
                }
            } catch (error) {
                console.log('Не удалось загрузить кэш EPG:', error);
            }
        }

        await fetchEPG(epgUrl);
    }

    // Загрузка EPG с сервера
    async function fetchEPG(epgUrl) {
        try {
            const response = await fetch(epgUrl);
            if (!response.ok) throw new Error('Ошибка EPG: ' + response.status);

            const text = await response.text();
            await storeInDB('epg', {
                url: epgUrl,
                data: text,
                timestamp: Date.now()
            });

            parseEPG(text);
        } catch (error) {
            console.error('Ошибка загрузки EPG:', error);

            // Попробуем использовать кэш в случае ошибки
            const cached = await getFromDB('epg', epgUrl);
            if (cached) {
                parseEPG(cached.data);
            } else {
                throw error;
            }
        }
    }

    // Парсинг EPG XML
    function parseEPG(xmlText) {
        epgCache = {};

        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, "text/xml");

            // Парсим каналы
            const channels = xmlDoc.getElementsByTagName('channel');
            for (const channel of channels) {
                const id = channel.getAttribute('id');
                const displayNames = channel.getElementsByTagName('display-name');
                const icon = channel.getElementsByTagName('icon')[0];

                const names = Array.from(displayNames).map(el => el.textContent);

                epgCache[id] = {
                    names: names,
                    icon: icon?.getAttribute('src'),
                    programs: []
                };
            }

            // Парсим программы
            const programs = xmlDoc.getElementsByTagName('programme');
            for (const program of programs) {
                const channelId = program.getAttribute('channel');
                const start = program.getAttribute('start');
                const stop = program.getAttribute('stop');
                const titleEl = program.getElementsByTagName('title')[0];
                const descEl = program.getElementsByTagName('desc')[0];

                const title = titleEl?.textContent || 'Нет названия';
                const desc = descEl?.textContent || '';

                if (epgCache[channelId]) {
                    epgCache[channelId].programs.push({
                        start,
                        stop,
                        title,
                        desc
                    });
                }
            }

            // Сортируем программы по времени
            for (const channelId in epgCache) {
                if (epgCache.hasOwnProperty(channelId)) {
                    epgCache[channelId].programs.sort((a, b) =>
                        parseEPGTime(a.start) - parseEPGTime(b.start)
                    );
                }
            }
        } catch (error) {
            console.error('Ошибка парсинга EPG:', error);
            throw error;
        }
    }

    // Отображение списка каналов
    function renderChannels(filter = '', group = '') {
        const container = document.getElementById('channels-list');
        if (!container) return;

        container.innerHTML = '';

        const filteredChannels = channelsCache.filter(channel => {
            const nameMatch = channel.name.toLowerCase().includes(filter.toLowerCase());
            const groupMatch = !group || channel.group === group;
            return nameMatch && groupMatch;
        });

        if (filteredChannels.length === 0) {
            container.innerHTML = '<div class="no-results">Каналы не найдены</div>';
            return;
        }

        filteredChannels.forEach(channel => {
            const channelElement = document.createElement('div');
            channelElement.className = 'channel-item';

            if (currentChannel?.url === channel.url) {
                channelElement.classList.add('active');
            }

            channelElement.dataset.url = channel.url;
            const epgData = findMatchingEPG(channel.name);
            const currentProgram = getCurrentProgram(epgData);
            const progressBar = renderChannelProgressBar(epgData);

            channelElement.innerHTML = `
                <img class="channel-logo" src="${(epgData?.icon) || 'no_logo.png'}" alt="${channel.name}"
                     onerror="this.src='/css/no_logo.png'">
                <div class="channel-info">
                    <div class="channel-name">${channel.name}</div>
                    <div class="channel-program">${currentProgram}</div>
                    ${progressBar}
                </div>
            `;

            channelElement.addEventListener('click', () => playChannel(channel, epgData));
            container.appendChild(channelElement);
        });
    }

    // Поиск соответствия EPG для канала
    function findMatchingEPG(channelName) {
        if (!channelName) return null;

        // 1. Точное совпадение
        for (const channelId in epgCache) {
            if (epgCache.hasOwnProperty(channelId)) {
                const exactMatch = epgCache[channelId].names.some(name =>
                    name.trim().toLowerCase() === channelName.trim().toLowerCase()
                );

                if (exactMatch) {
                    return {
                        channelId,
                        icon: epgCache[channelId].icon,
                        programs: epgCache[channelId].programs
                    };
                }
            }
        }

        // 2. Очистка имени и поиск частичного совпадения
        const cleanChannelName = channelName
            .replace(/\+[0-9]+\s*\([^)]+\)/g, '')
            .replace(/HD|FHD|UHD|4K/i, '')
            .replace(/[^a-zA-Zа-яА-Я0-9\s]/g, '')
            .trim()
            .toLowerCase();

        for (const channelId in epgCache) {
            if (epgCache.hasOwnProperty(channelId)) {
                const epgNames = epgCache[channelId].names.map(name =>
                    name.replace(/[^a-zA-Zа-яА-Я0-9\s]/g, '')
                        .trim()
                        .toLowerCase()
                );

                const partialMatch = epgNames.some(name =>
                    name.includes(cleanChannelName) || cleanChannelName.includes(name)
                );

                if (partialMatch) {
                    return {
                        channelId,
                        icon: epgCache[channelId].icon,
                        programs: epgCache[channelId].programs
                    };
                }
            }
        }

        // 3. Специальные случаи для популярных каналов
        for (const name in SPECIAL_CHANNELS) {
            if (SPECIAL_CHANNELS.hasOwnProperty(name) && cleanChannelName.includes(name)) {
                const channelId = SPECIAL_CHANNELS[name];
                if (epgCache[channelId]) {
                    return {
                        channelId,
                        icon: epgCache[channelId].icon,
                        programs: epgCache[channelId].programs
                    };
                }
            }
        }

        return null;
    }

    // Получение текущей программы
    function getCurrentProgram(epgData) {
        if (!epgData?.programs?.length) return 'Нет данных';

        const now = new Date();

        for (const program of epgData.programs) {
            const startTime = parseEPGTime(program.start);
            const endTime = parseEPGTime(program.stop);

            // Корректируем время с учетом разницы часовых поясов
            const adjustedStartTime = new Date(startTime.getTime());
            const adjustedEndTime = new Date(endTime.getTime());

            if (now >= adjustedStartTime && now <= adjustedEndTime) {
                return `${program.title} • до ${formatTime(adjustedEndTime)}`;
            }
        }

        return 'Нет данных';
    }

    // Форматирование времени
    function formatTime(date) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    // Парсинг времени EPG
    function parseEPGTime(timeStr) {
        const year = parseInt(timeStr.substr(0, 4), 10);
        const month = parseInt(timeStr.substr(4, 2), 10) - 1;
        const day = parseInt(timeStr.substr(6, 2), 10);
        const hour = parseInt(timeStr.substr(8, 2), 10);
        const minute = parseInt(timeStr.substr(10, 2), 10);
        const second = parseInt(timeStr.substr(12, 2), 10) || 0;

        // Создаем дату в часовом поясе EPG (+3 UTC)
        const date = new Date(Date.UTC(year, month, day, hour, minute, second));

        // Корректируем на разницу между поясом EPG и UTC
        date.setMinutes(date.getMinutes() + EPG_TIMEZONE_OFFSET * 60);

        return date;
    }

    // Рендеринг прогресс-бара
    function renderChannelProgressBar(epgData) {
        if (!epgData?.programs?.length) return '';

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

        if (!currentProgram) return '';

        return `<div class="channel-progress-container">
            <div class="channel-progress-bar" style="width:${progress}%"></div>
        </div>`;
    }

    // Воспроизведение канала
    function playChannel(channel, epgData) {
        currentChannel = {
            name: channel.name,
            url: channel.url,
            group: channel.group,
            epgData
        };

        // Обновляем активный канал в списке
        document.querySelectorAll('.channel-item').forEach(item => {
            item.classList.toggle('active', item.dataset.url === channel.url);
        });

        const playerContainer = document.getElementById('player-container');
        playerContainer.innerHTML = '<div id="player"></div>';

        // Уничтожаем предыдущий экземпляр плеера
        if (venomPlayerInstance) {
            try {
                venomPlayerInstance.destroy();
            } catch (e) {
                console.error('Ошибка уничтожения плеера:', e);
            }
        }

        // Проверяем наличие VenomPlayer
        if (!window.VenomPlayer || typeof VenomPlayer.make !== 'function') {
            playerContainer.innerHTML = `
                <video controls autoplay style="width:100%;height:100%;background:#000;">
                    <source src="${channel.url}" type="application/x-mpegURL">
                    Ваш браузер не поддерживает видео элемент.
                </video>
            `;
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

            renderEPG(epgData);
        } catch (error) {
            console.error('Ошибка инициализации плеера:', error);
            playerContainer.innerHTML = '<div class="error">Ошибка загрузки плеера</div>';
        }
    }

    // Отображение EPG
    function renderEPG(epgData) {
        const container = document.getElementById('epg-container');
        if (!container) return;

        if (!epgData?.programs?.length) {
            container.innerHTML = '<div class="no-results">Нет данных о программе</div>';
            return;
        }

        container.innerHTML = '<div class="epg-program-list"></div>';
        const programList = container.querySelector('.epg-program-list');
        const now = new Date();

        // Показываем текущую программу и следующие 5 программ
        const programsToShow = [];
        let foundCurrent = false;

        for (const program of epgData.programs) {
            const startTime = parseEPGTime(program.start);
            const endTime = parseEPGTime(program.stop);

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

        if (programsToShow.length === 0 && epgData.programs.length > 0) {
            // Нет текущих или будущих программ, показываем последнюю программу
            const lastProgram = epgData.programs[epgData.programs.length - 1];
            lastProgram.isCurrent = false;
            programsToShow.push(lastProgram);
        }

        // Рендерим программы
        programsToShow.forEach(program => {
            const programElement = document.createElement('div');
            programElement.className = `epg-program-item ${program.isCurrent ? 'current-program' : ''}`;

            const startTime = parseEPGTime(program.start);
            const endTime = parseEPGTime(program.stop);

            programElement.innerHTML = `
                <div class="epg-program-time">${formatTime(startTime)} - ${formatTime(endTime)}</div>
                <div class="epg-program-title">${program.title}</div>
            `;

            if (program.desc) {
                programElement.title = program.desc;
            }

            programList.appendChild(programElement);
        });
    }

    // ===== IndexedDB helpers =====
    function storeInDB(storeName, data) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put(data);

            request.onsuccess = () => resolve();
            request.onerror = event => reject(event.target.error);
        });
    }

    function getFromDB(storeName, key) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result);
            request.onerror = event => reject(event.target.error);
        });
    }

    function getAllFromDB(storeName) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
            request.onerror = event => reject(event.target.error);
        });
    }

    function clearDB(storeName) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = event => reject(event.target.error);
        });
    }
