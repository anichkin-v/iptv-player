<?php
// IPTV Web Player 4.5.19
?>
<!DOCTYPE html>
<html lang="ru-RU">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1.0, minimum-scale=1.0">
    <meta name="description" content="IPTV Web Player - наслаждайтесь любимыми  передачами.">

    <!-- SEO -->
    <meta name="keywords" content="iptv">
    <meta name="author" content="IPTV Web Player">
    <meta name="robots" content="index, follow">

    <!-- Open Graph (OG) - для социальных сетей -->
    <meta property="og:title" content="IPTV Web Player - Смотрите Онлайн">
    <meta property="og:description" content="Наслаждайтесь любимыми  передачами онлайн на IPTV Web Player. Бесплатно, без регистрации.">
    <meta property="og:image" content="http://iptv.apiweb.uz/css/favicon/no_logo.png">
    <meta property="og:url" content="http://iptv.apiweb.uz/">
    <meta property="og:type" content="website">

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="IPTV Web Player - Смотрите Онлайн">
    <meta name="twitter:description" content="Наслаждайтесь любимыми  передачами онлайн на IPTV Web Player. Бесплатно, без регистрации.">
    <meta name="twitter:image" content="http://iptv.apiweb.uz/css/favicon/no_logo.png">

    <!-- Favicon -->
    <link rel="icon" href="http://iptv.apiweb.uz/css/favicon/favicon.ico" sizes="48x48">
    <link rel="apple-touch-icon" href="http://iptv.apiweb.uz/css/favicon/apple-touch-icon.png"/>
    <link rel="manifest" href="http://iptv.apiweb.uz/css/favicon/manifest.webmanifest"/>

    <!-- Theme color for mobile browsers -->
    <meta name="theme-color" content="#181818">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black">

    <!-- JSON-LD structured data for SEO -->
    <script type="application/ld+json">
        {
            "@context": "https://schema.org",
            "@type": "WebSite",
            "url": "http://iptv.apiweb.uz/",
            "name": "IPTV Web Player",
            "description": "Наслаждайтесь любимыми  передачами онлайн на IPTV Web Player. Бесплатно, без регистрации.",
            "sameAs": [
                "https://www.facebook.com",
                "https://twitter.com",
                "https://www.instagram.com"
            ],
            "image": "http://iptv.apiweb.uz/css/favicon/no_logo.png",
            "author": {
                "@type": "Organization",
                "name": "IPTV Web Player"
            }
        }
    </script>
    <script>
      (function(){
        if (!window.t) window.t = function(k, fb){ return fb || k; };
      })();
    </script>

    <link rel="preload" href="./js/i18n.js" as="script" importance="high">
    <link rel="preload" href="./js/init.js" as="script" importance="high">

    <script src="./js/i18n.js"></script>
    <script src="./js/init.js"></script>

    <link rel="prefetch" href="./i18n/ru.json" as="fetch" type="application/json" crossorigin>
    <link rel="prefetch" href="./i18n/en.json" as="fetch" type="application/json" crossorigin>
    <link rel="prefetch" href="./i18n/uz.json" as="fetch" type="application/json" crossorigin>

    <script>
      window.t = (key, fb) => I18N_AJAX.t(key, fb);

      (async function () {
        if (!I18N_AJAX.isReady) {
          await I18N_AJAX.init({
            defaultLang: 'ru',
            supported: ['ru','en','uz'],
            basePath: './i18n'
          });
          I18N_AJAX.apply(document);
          document.dispatchEvent(new Event('i18n:ready'));
        }

        const cur = I18N_AJAX.getLang();
        document.querySelectorAll('.lang-btn').forEach(btn => {
          btn.setAttribute('aria-current', String(btn.dataset.lang === cur));
          btn.addEventListener('click', async () => {
            if (btn.dataset.lang === I18N_AJAX.getLang()) return; // не дергаем второй раз
            await I18N_AJAX.setLang(btn.dataset.lang);
            document.querySelectorAll('.lang-btn').forEach(b =>
              b.setAttribute('aria-current', String(b === btn))
            );
            I18N_AJAX.apply(document);
            document.dispatchEvent(new Event('i18n:changed'));
          });
        });
      })().catch(e => console.error('i18n init failed:', e));
    </script>

    <title>IPTV Web Player</title>
    <!-- Network hints -->
    <link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>
    <link rel="dns-prefetch" href="//cdnjs.cloudflare.com">

    <!-- Critical CSS -->
    <link rel="preload" href="./css/style.css" as="style">
    <link rel="stylesheet" href="./css/style.css">
<style>
    #record-segment{
        width: 100%;
        padding: 8px;
        font-size: 0.9rem;
        background-color: var(--bg-color);
        color: var(--text-color);
        border: 1px solid var(--hover-color);
        border-radius: 6px;
        -webkit-appearance: none;
    }
</style>
    <!-- Font Awesome — неблокирующе -->
    <link rel="preload" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/7.0.0/css/all.min.css" as="style" crossorigin onload="this.onload=null;this.rel='stylesheet'">
    <noscript><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/7.0.0/css/all.min.css" crossorigin></noscript>
</head>
<body>
<div id="header">
    <!-- Левая секция: Логотип и название -->
    <div class="header-section">
        <div class="header-content">
            <i class="fas fa-tv"></i>
            <span id="app-title">IPTV Web Player</span>
        </div>
        <!-- Языки -->
        <div class="lang-switcher" id="lang-switcher">
            <button  class="lang-btn" data-lang="ru" title="Русский" aria-label="Русский"> RU </button>
            <button  class="lang-btn" data-lang="en" title="English" aria-label="English"> EN </button>
            <button  class="lang-btn" data-lang="uz" title="Oʻzbekcha" aria-label="O'zbekcha"> UZ </button>
        </div>
    </div>

    <!-- Центральная секция: Кнопки -->
    <div class="header-section">
        <button id="load-new-playlist" class="header-button">
            <i class="fas fa-folder-plus"></i> <span data-i18n="ui.плейлист"></span></button>
        <button id="refresh-epg" class="header-button">
            <i class="fas fa-sync-alt"></i> EPG
        </button>
        <div class="recording-controls" style="display:flex; gap:8px; align-items:center;">
            <button id="record-start" class="header-button"><span data-i18n="ui.запись"></span></button>
            <button id="record-stop" class="header-button"><span data-i18n="ui.стоп"></span></button>
            <label style="display:flex;gap:6px;align-items:center;"
                   title="Эта настройка нарезает и сохраняет трансляцию сегментами по 15 минут (по умолчанию)">
                <span data-i18n="ui.сегмент"></span>
                <select id="record-segment">
                    <option value="manual" data-i18n="ui.manual">Ручной</option>
                    <option value="5" data-i18n="ui.5_min">5 мин</option>
                    <option value="10" data-i18n="ui.10_min">10 мин</option>
                    <option value="15" selected data-i18n="ui.15_min">15 мин</option>
                    <option value="30" data-i18n="ui.30_min">30 мин</option>
                    <option value="60" data-i18n="ui.60_min">60 мин</option>
                </select>
            </label>
        </div>
    </div>

    <!-- Правая секция: Время и часовой пояс -->
    <div class="header-section">
        <div class="time-zone-info">
            <div class="current-time" id="current-time">--:--</div>
            <div class="timezone-label" id="timezone-label"><span data-i18n="ui.загрузка"></span></div>
        </div>
    </div>
</div>

<div id="main-container">
    <div id="sidebar">
        <div id="filter-controls">
            <select id="group-filter">
                <option value=""><span data-i18n="ui.все_группы"></span></option>
            </select>

            <button id="favorites-filter-btn" class="header-button" title="Показать избранные">
                <i class="fas fa-star"></i>
            </button>
            <div class="search-container">
                <input type="text" id="search" data-i18n-attr="placeholder:ui.search">
                <span class="search-clear">&times;</span>
            </div>
        </div>
        <div id="channels-list">
            <div class="loading"><span data-i18n="ui.загрузка_каналов"></span></div>
        </div>
    </div>

    <div id="main-content">
        <div id="player-container">
            <div class="loading"><span data-i18n="ui.загрузка_плеера"></span></div>
        </div>
        <div id="epg-container">
            <div class="loading"><span data-i18n="ui.загрузка_программы"></span></div>
        </div>
    </div>
</div>

<!-- Playlist dialog -->
<div id="playlist-dialog" class="dialog-overlay">
    <div class="dialog">
        <div class="dialog-header">
            <div class="dialog-title"><span data-i18n="ui.добро_пожаловать_в_iptv_web_player"></span></div>
            <button class="dialog-close">&times;</button>
        </div>
        <div class="dialog-body">
            <div class="welcome-text"><span data-i18n="ui.плейлисты_автоматически_сохраняются_в_бр"></span> <strong><span data-i18n="ui.365_дней"></span></strong><br><span data-i18n="ui.epg_программа_передач_обновляется_каждые"></span> <strong><span data-i18n="ui.12_часов"></span></strong> <br>
            </div>

            <div class="dialog-tabs">
                <div class="dialog-tab active" data-tab="url-tab">URL</div>
                <div class="dialog-tab" data-tab="file-tab"><span data-i18n="ui.файл"></span></div>
                <div class="dialog-tab" data-tab="demo-tab"><span data-i18n="ui.демо-плейлист"></span></div>
            </div>

            <!-- Загрузка по URL -->
            <div id="url-tab" class="dialog-content active">
                <div class="form-group">
                    <label class="form-label"><span data-i18n="ui.url_плейлиста_m3um3u8"></span></label>
                    <input id="playlist-url" class="form-input" type="url"
                           placeholder="http://example.com/playlist.m3u8">
                    <div class="form-hint"><span data-i18n="ui.поддерживаются_форматы_m3u_m3u8_с_httpht"></span></div>
                </div>
                <div class="form-group">
                    <button class="btn btn-primary" id="load-url-btn">
                        <i class="fas fa-cloud-download-alt"></i>  <span data-i18n="ui.загрузить_из_интернета"></span></button>
                </div>
                <div id="url-status" class="status-message"></div>
            </div>

            <!-- Загрузка файла -->
            <div id="file-tab" class="dialog-content">
                <div class="form-group">
                    <label class="form-label"><span data-i18n="ui.выберите_файл_плейлиста"></span></label>
                    <div class="file-input-wrapper">
                        <button class="file-input-btn">
                            <i class="fas fa-folder-open"></i><span data-i18n="ui.выбрать_файл_m3u_m3u8"></span></button>
                        <input type="file" id="playlist-file" class="file-input" accept=".m3u,.m3u8">
                    </div>
                    <div id="file-name" class="file-name"><span data-i18n="ui.файл_не_выбран"></span></div>
                    <div class="form-hint"><span data-i18n="ui.загрузите_локальный_файл_плейлиста_с_ваш"></span></div>
                </div>
                <div class="form-group">
                    <button class="btn btn-primary" id="load-file-btn" disabled>
                        <i class="fas fa-upload"></i>  <span data-i18n="ui.загрузить_файл"></span></button>
                </div>
                <div id="file-status" class="status-message"></div>
            </div>

            <!-- Тестовый плейлист -->
            <div id="demo-tab" class="dialog-content">
                <div class="form-group">
                    <div class="alert-primary">
                      <p><span data-i18n="ui.демонстрационный_плейлист_с_сервера"></span> <a href="https://iptv.axenov.dev" target="_blank" rel="noopener noreferrer">iptv.axenov.dev</a></p>
                    </div>
                </div>
                <div class="form-group">
                    <button class="btn btn-primary" id="load-default-btn">
                        <i class="fas fa-play-circle"></i> <span data-i18n="ui.загрузить_демо-плейлист"></span></button>
                </div>
                <div id="demo-status" class="status-message"></div>
            </div>
        </div>
        <div class="dialog-footer">
            <p style="margin: 0; font-size: 12px; color: #959494; text-align: left;"><span data-i18n="ui.не_знаете_где_взять_плейлист_попробуйте_"></span></p>
        </div>
    </div>

</div>
<!-- EPG dialog -->
<div id="epg-dialog" class="dialog-overlay">
    <div class="dialog">
        <div class="dialog-header">
            <div class="dialog-title"><span data-i18n="ui.обновление_epg"></span></div>
            <button class="dialog-close">&times;</button>
        </div>
        <div class="dialog-body">
            <p><span data-i18n="ui.вы_уверены_что_хотите_обновить_данные_эл"></span></p>
            <p><span data-i18n="ui.это_может_занять_некоторое_время"></span></p>
            <div id="epg-status" class="status-message"></div>
        </div>
        <div class="dialog-footer">
            <button id="cancel-epg-btn" class="btn btn-outline"><span data-i18n="ui.отмена"></span></button>
            <button id="refresh-epg-btn" class="btn btn-primary">
                <i class="fas fa-sync-alt"></i><span data-i18n="ui.обновить"></span></button>
        </div>
    </div>
</div>

<script src="./dist/player.js" defer></script>
<script src="./js/iptv.js" defer></script>
<script>window.UA_PROXY_PATH = '/user-agent-proxy.php';</script>
<script src="./js/ua_settings.js" defer></script>
<script src="./js/favorites.js" defer></script>
<script src="./js/epg-icon-cache.js"></script>
<script>
(async function setupTimezone() {
  // ===== i18n helpers =====
  const tr = (k, fb) => {
    try {
      if (typeof window.t === 'function') return window.t(k, fb);
      if (window.I18N_AJAX?.t) return window.I18N_AJAX.t(k, fb);
    } catch(_) {}
    return fb ?? k;
  };
  const getUILocale = () => {
    const raw = (window.I18N_AJAX?.lang) || document.documentElement.lang || navigator.language || 'ru';
    const short = String(raw).split('-')[0].toLowerCase();
    const map = { ru: 'ru-RU', en: 'en-GB', uz: 'uz-UZ' };
    return map[short] || raw;
  };

  // ===== state =====
  let detectedTimezone = null;
  let detectedCity = null;

  // ===== helpers =====
  function getBrowserTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
    catch { return null; }
  }
  function formatTimezoneAsCity(timezone) {
    if (!timezone) return tr('ui.unknown', 'Unknown');
    const parts = String(timezone).split('/');
    return (parts.length >= 2 ? parts[parts.length - 1] : timezone).replace(/_/g, ' ');
  }
  function getCurrentTime() {
    const tz = detectedTimezone || 'UTC';
    try {
      return new Intl.DateTimeFormat(getUILocale(), {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
      }).format(new Date());
    } catch {
      const now = new Date();
      return `${now.getUTCHours().toString().padStart(2, '0')}:${now.getUTCMinutes().toString().padStart(2, '0')}`;
    }
  }
  function updateDisplay() {
    const timeEl = document.getElementById('current-time');
    const zoneEl = document.getElementById('timezone-label');
    if (timeEl) timeEl.textContent = getCurrentTime();
    if (zoneEl) zoneEl.textContent = detectedCity || formatTimezoneAsCity(detectedTimezone);
  }

  // ===== GeoIP over HTTPS only =====
  async function getTimezoneFromGeoIP() {
    const services = [
      { url: 'https://ipapi.co/json/', parse: d => ({ timezone: d.timezone, city: d.city }) },
      { url: 'https://ipwho.is/',      parse: d => (d.success === false ? null : { timezone: d.timezone, city: d.city }) },
      { url: 'https://get.geojs.io/v1/ip/geo.json', parse: d => ({ timezone: d.timezone, city: d.city }) },
    ];
    for (const s of services) {
      try {
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch(s.url, { signal: controller.signal, headers: { 'Accept': 'application/json' }, credentials: 'omit' });
        clearTimeout(to);
        if (!resp.ok) continue;
        const data = await resp.json();
        const r = s.parse(data);
        if (r && r.timezone) return r;
      } catch { /* try next */ }
    }
    return null;
  }

  // ===== Geolocation (HTTPS/localhost). City is NOT coordinates =====
  async function getTimezoneFromGeolocation() {
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return null;
    if (!('geolocation' in navigator)) return null;
    return new Promise(resolve => {
      const timeout = setTimeout(() => resolve(null), 8000);
      navigator.geolocation.getCurrentPosition(
        () => { // координаты не используем как город
          clearTimeout(timeout);
          resolve({ timezone: getBrowserTimezone() || 'UTC', city: null });
        },
        () => { clearTimeout(timeout); resolve(null); },
        { timeout: 7000, maximumAge: 300000 }
      );
    });
  }

  // ===== localStorage cache =====
  const LOC_KEY = 'iptv:loc';
  const LOC_TTL = 24 * 60 * 60 * 1000; // 24h
  const loadSavedLoc = () => { try { return JSON.parse(localStorage.getItem(LOC_KEY) || 'null'); } catch { return null; } };
  const saveLoc = (tz, city) => { try { localStorage.setItem(LOC_KEY, JSON.stringify({ tz, city, ts: Date.now() })); } catch {} };

  // ===== UI pre-state =====
  const zoneEl = document.getElementById('timezone-label');
  if (zoneEl) zoneEl.textContent = tr('ui.locating', 'Detecting location…');

  // Try cached first
  const saved = loadSavedLoc();
  if (saved && (Date.now() - (saved.ts || 0) < LOC_TTL)) {
    detectedTimezone = saved.tz;
    detectedCity = saved.city || formatTimezoneAsCity(saved.tz);
    updateDisplay();
  }

  // ===== main flow =====
  try {
    const browserTz = getBrowserTimezone();
    const [geoip, geoloc] = await Promise.all([
      getTimezoneFromGeoIP(),      // timezone + city
      getTimezoneFromGeolocation() // timezone only
    ]);

    detectedTimezone = geoloc?.timezone || geoip?.timezone || browserTz || 'UTC';
    detectedCity     = geoip?.city || formatTimezoneAsCity(detectedTimezone);

    saveLoc(detectedTimezone, detectedCity);
    updateDisplay();
  } catch {
    detectedTimezone = getBrowserTimezone() || 'UTC';
    detectedCity = tr('ui.local_time', 'Local time');
    updateDisplay();
  }

  // keep time fresh
  setInterval(updateDisplay, 60_000);
  window.addEventListener('languagechange', updateDisplay);
  document.addEventListener('i18n:changed', updateDisplay);
})();
</script>

</body>
</html>