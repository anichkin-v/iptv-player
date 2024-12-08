let m3u8Playlist = [];          // Массив для хранения списка каналов
let categories = new Set();     // Множество для хранения категорий каналов
let selectedChannel = null;     // Выбранный канал
let epgChannels = {};           // Объект для хранения EPG данных
let venomPlayerInstance = null; // Хранит инстанс VenomPlayer

// Элементы интерфейса
const categorySelect = document.getElementById('filter-group');
const channelsList = document.getElementById('channels');

const currentProgramTitle = document.getElementById('current-program-title');
const programList = document.getElementById('epg-list');  // Элемент для списка передач

// Загружаем EPG с внешнего источника
async function loadEPG() {
    try {
        const response = await fetch('http://epg.one/epg2.xml');
        if (!response.ok) throw new Error('Ошибка загрузки EPG');
        const data = await response.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(data, 'application/xml');
        parseEPG(xmlDoc);
    } catch (err) {
        console.error('Ошибка загрузки EPG:', err);
    }
}

// Парсим XML данные EPG и сохраняем их
function parseEPG(xmlDoc) {
    const channels = [...xmlDoc.getElementsByTagName('channel')];
    channels.forEach(channel => {
        const id = channel.getAttribute('id');
        const names = [...channel.querySelectorAll('display-name')].map(name => name.textContent.trim().toLowerCase());
        const icon = channel.querySelector('icon')?.getAttribute('src') || '';
        const programmes = [...xmlDoc.getElementsByTagName('programme')].filter(prog => prog.getAttribute('channel') === id);

        names.forEach(name => {
            epgChannels[name] = { id, names, icon, programmes };
        });
    });
    console.log("EPG загружен:", epgChannels);
    updateCategoryList();  // Обновляем список категорий
    updateChannelList('all');  // Обновляем список каналов
}

// Функция для поиска данных EPG по названию канала
function findEpgData(channelName) {
    return epgChannels[channelName];
}

// Функция для получения текущей программы для канала
function getCurrentProgram(epgData) {
    if (!epgData) return null;
    const now = new Date();
    const programmes = epgData.programmes;

    for (let prog of programmes) {
        const start = formatEPGTime(prog.getAttribute('start'));
        const stop = formatEPGTime(prog.getAttribute('stop'));
        if (now >= start && now < stop) {
            return prog.querySelector('title').textContent;
        }
    }
    return null;
}

// Форматируем время из EPG в объект Date
function formatEPGTime(epgTime) {
    const datePart = epgTime.substring(0, 14);
    const timeZonePart = epgTime.substring(15);
    return new Date(`${datePart.substring(0, 4)}-${datePart.substring(4, 6)}-${datePart.substring(6, 8)}T${datePart.substring(8, 10)}:${datePart.substring(10, 12)}:${datePart.substring(12, 14)}${timeZonePart}`);
}

// Загружаем M3U8 файл (плейлист каналов)
async function loadM3U8File(url) {
    try {
        const response = await fetch(url);
        const data = await response.text();
        parseM3U8(data);  // Парсим плейлист
        await loadEPG();  // Загружаем EPG после загрузки плейлиста
    } catch (err) {
        console.error('Ошибка загрузки плейлиста:', err);
    }
}

// Парсим данные M3U8
function parseM3U8(data) {
    const lines = data.split('\n');
    let currentChannel = {};

    lines.forEach(line => {
        if (line.startsWith('#EXTINF:')) {
            const titleMatch = line.match(/,(.*)/);
            if (titleMatch) currentChannel.title = titleMatch[1].trim();
        } else if (line.startsWith('#EXTGRP:')) {
            const groupMatch = line.match(/#EXTGRP:(.*)/);
            if (groupMatch) {
                currentChannel.group = groupMatch[1].trim();
                categories.add(currentChannel.group);  // Добавляем группу в набор категорий
            }
        } else if (line.match(/^http/)) {
            currentChannel.url = line.trim();
            m3u8Playlist.push(currentChannel);  // Добавляем канал в список
            currentChannel = {};  // Сбрасываем текущий канал
        }
    });

    updateCategoryList();  // Обновляем список категорий
    updateChannelList('all');  // Обновляем список всех каналов
}

// Обновляем список категорий для фильтра
function updateCategoryList() {
    categorySelect.innerHTML = `<option value="all">Все категории</option>`;  // Добавляем опцию "Все"
    categories.forEach(category => {
        categorySelect.innerHTML += `<option value="${category}">${category}</option>`;
    });
}

// Обновляем список каналов на основе выбранной категории
function updateChannelList(category) {
    channelsList.innerHTML = '';  // Очищаем текущий список

    // Если категория "all", показываем все каналы
    const filteredChannels = category === 'all'
        ? m3u8Playlist
        : m3u8Playlist.filter(channel => channel.group === category);

    filteredChannels.forEach(channel => {
        const channelDiv = document.createElement('div');
        channelDiv.className = 'channel';

        const epgData = findEpgData(channel.title.toLowerCase());
        const iconSrc = epgData?.icon || './no_logo.png';  // Иконка канала (по умолчанию если не найдено)
        const currentProgram = getCurrentProgram(epgData);  // Текущая программа

        // Структура HTML для отображения канала
        channelDiv.innerHTML = `
                <img src="${iconSrc}" alt="Icon" class="channel-icon">
                <div class="channel-info">
                    <div class="channel-title">${channel.title}</div>
                    <div class="current-program">${currentProgram || 'Нет программы'}</div>
                </div>
            `;

        // При клике на канал - воспроизводим
        channelDiv.onclick = () => {
            playChannel(channel.url, channel);
        };
        channelsList.appendChild(channelDiv);
    });
}

// Функция для отображения текущей программы в EPG
function displayCurrentEPG() {
    if (!selectedChannel) return;

    const epgData = findEpgData(selectedChannel.title.toLowerCase());
    const currentProgram = getCurrentProgram(epgData);  // Текущая программа

    // Обновляем заголовок с текущей программой
    if (currentProgram) {
        currentProgramTitle.textContent = `Сейчас: ${currentProgram}`;
    } else {
        currentProgramTitle.textContent = 'Нет программы';
    }

    // Обновляем список передач на основе текущего канала
    const programmes = epgData?.programmes || [];
    programList.innerHTML = '';  // Очищаем список программ перед добавлением новых

    programmes.forEach(prog => {
        const programDiv = document.createElement('div');
        // Форматируем время начала и окончания передачи
        const options = { hour: '2-digit', minute: '2-digit' };
        const start = formatEPGTime(prog.getAttribute('start')).toLocaleTimeString('ru-RU', options);
        const stop = formatEPGTime(prog.getAttribute('stop')).toLocaleTimeString('ru-RU', options);
        const programTitle = prog.querySelector('title').textContent;

        // Форматируем строку с временем начала и окончания передачи
        const timeString = `${start} - ${stop}`;

        programDiv.innerHTML = `
            <div>${timeString} : ${programTitle}</div>
        `;
        programList.appendChild(programDiv);
    });
}

// Функция для воспроизведения потока
function playChannel(url, channel) {
    // Остановить и удалить предыдущий поток, если он воспроизводится
    if (typeof venomPlayerInstance !== 'undefined' && venomPlayerInstance !== null) {
        venomPlayerInstance.destroy(); // Удалить предыдущий плеер
        console.log("Previous player destroyed.");
    }

    selectedChannel = channel;
    const player = document.getElementById('player');

    // Проверка, существует ли элемент для плеера
    if (!player) {
        console.error("Player container not found.");
        return;
    }

    try {
        // Создаем новый инстанс VenomPlayer
        venomPlayerInstance = VenomPlayer.make({
            container: player, // Контейнер для плеера
            publicPath: './dist/', // Путь к публичным файлам
            syncUser: true, // Синхронизация пользователя (если необходимо)
            blocked: false, // Разрешить воспроизведение
            theme: 'classic', // Тема плеера
            aspectRatio: '16:9', // Соотношение сторон
            autoPlay: false, // Автозапуск (изменил на true для немедленного старта)
            volume: 1, // Уровень громкости
            online: true, // Подключение к интернету
            live: true,
            title: channel.title, // Название канала
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
                hls: url, // URL потока HLS
                type: 'application/x-mpegURL' // Тип потока
            },
            quality: function (q) {
                if (q > 2000) return q+'K';
                if (q > 1079) return 'fHD '+q;
                if (q > 719) return 'HD '+q;
                return q;
            },
            hlsConfig: {
                maxBufferLength: 420, // Максимальное количество секунд в буфере
                maxBufferSize: 20 * 1024 * 1024, // Максимальный размер буфера в байтах (30 MB)
                liveSyncDuration: 60, // Время синхронизации с живым потоком
                liveMaxLatencyDuration: 30, // Максимальная задержка для живого потока
                lowLatencyMode: true // Включить режим низкой задержки
            }
        });

        console.log("VenomPlayer initialized successfully.");

        // Обновляем EPG для выбранного канала
        displayCurrentEPG();

    } catch (error) {
        console.error("Error initializing VenomPlayer:", error);
    }
}

// Обработчик изменения фильтра категорий
categorySelect.onchange = (event) => {
    updateChannelList(event.target.value);  // Обновляем список каналов по выбранной категории
};

// Открытие и закрытие попапа
const openPopupBtn = document.getElementById('open-playlist-popup');
const closePopupBtn = document.getElementById('close-popup');
const playlistPopup = document.getElementById('playlist-popup');
const playlistFileInput = document.getElementById('playlist-file');
const playlistUrlInput = document.getElementById('playlist-url');
const loadPlaylistBtn = document.getElementById('load-playlist');

openPopupBtn.onclick = () => {
    playlistPopup.style.display = 'block';
};

closePopupBtn.onclick = () => {
    playlistPopup.style.display = 'none';
};

// Загрузка плейлиста из файла или URL
loadPlaylistBtn.onclick = () => {
    const file = playlistFileInput.files[0];
    const url = playlistUrlInput.value.trim();

    if (file) {
        const reader = new FileReader();
        reader.onload = () => {
            const text = reader.result;
            parseM3U8(text);  // Парсим плейлист
            const expirationTime = Date.now() + 365 * 24 * 60 * 1000;  // Плейлист будет храниться 365 дней
            localStorage.setItem('playlist', text);
            localStorage.setItem('playlist-expiration', expirationTime);
            loadEPG();  // Загружаем EPG
            playlistPopup.style.display = 'none';
        };
        reader.readAsText(file);
    } else if (url) {
        loadM3U8File(url).then(() => {
            const expirationTime = Date.now() + 365 * 24 * 60 * 1000;
            localStorage.setItem('playlist-url', url);  // Сохраняем URL в localStorage
            localStorage.setItem('playlist-url-expiration', expirationTime);
            playlistPopup.style.display = 'none';
        });
    } else {
        alert('Пожалуйста, загрузите файл или введите URL.');
    }
};

// Проверка наличия сохраненного плейлиста при загрузке страницы
window.onload = () => {
    const savedPlaylist = localStorage.getItem('playlist');
    const savedPlaylistExpiration = localStorage.getItem('playlist-expiration');

    if (savedPlaylist && savedPlaylistExpiration && Date.now() < Number(savedPlaylistExpiration)) {
        parseM3U8(savedPlaylist);  // Парсим сохраненный плейлист
        loadEPG();  // Загружаем EPG данные
    } else {
        const savedPlaylistUrl = localStorage.getItem('playlist-url');
        const savedPlaylistUrlExpiration = localStorage.getItem('playlist-url-expiration');

        if (savedPlaylistUrl && savedPlaylistUrlExpiration && Date.now() < Number(savedPlaylistUrlExpiration)) {
            loadM3U8File(savedPlaylistUrl).then(() => {
                loadEPG();  // Загружаем EPG данные
            });
        }
    }
};
