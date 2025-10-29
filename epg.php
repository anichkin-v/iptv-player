<?php
/**
 * EPG fetcher/cacher (streaming validation, GZIP support)
 * - Кэш каждые 2 часа, начиная с 21:00 UTC
 * - Источник может быть .xml.gz или .xml
 * - Потоковая валидация/статистика через XMLReader (не держим 400+ МБ в памяти)
 * - Сохранение через временный файл и атомарный rename
 */

// ---------- Конфигурация ----------
$epgUrl         = 'http://epg.one/epg2.xml'; // ваш источник
$localEpgPath   = __DIR__ . '/epg.xml';
$tmpEpgPath     = __DIR__ . '/epg.xml.tmp';     // временный путь
$cacheStartHour = 21;                 // старт цикла по UTC
$cacheDuration  = 6 * 3600;           // 2 часа
$maxCompressed  = 128 * 1024 * 1024;  // лимит на сжатый ответ (128MB)
$httpTimeout    = 90;

// при желании можно расширить память (здесь не критично, но на всякий случай)
@ini_set('memory_limit', '1024M');

// ---------- Расписание ----------
function shouldCacheEpg($startHour, $duration) { return true; }

function getLastUpdateTime($startHour, $duration) {
    $now       = time();
    $h         = (int)gmdate('H', $now);
    $m         = (int)gmdate('i', $now);
    $curMin    = $h * 60 + $m;
    $startMin  = $startHour * 60;
    $delta     = $curMin - $startMin;
    if ($delta < 0) $delta += 24 * 60;
    $cycleMin  = (int)($duration / 60);
    $cycleNum  = (int)floor($delta / $cycleMin);
    $cycleBeg  = $cycleNum * $cycleMin;
    $dayStart  = strtotime(gmdate('Y-m-d 00:00:00'));
    return $dayStart + ($startMin + $cycleBeg) * 60;
}

// ---------- Вспомогательное: парс времени EPG ----------
/**
 * EPG обычно даёт start/stop вида: 20240826 123000 +0000 (или без пробелов),
 * 20240826123000 +0000, 20240826123000 +0300, 20240826123000 Z, и т.п.
 * Пытаемся привести к понятному для strtotime виду.
 */
function epgTimeToTs($s) {
    if (!$s) return null;
    $s = trim((string)$s);

    // Пробуем как есть
    $ts = strtotime($s);
    if ($ts !== false) return $ts;

    // Уберём все нецифровые/не знака +/- символы, оставив хвост TZ
    // Встретившийся формат часто "YYYYMMDDHHMMSS ±HHMM" или "YYYYMMDDHHMMSS Z"
    if (preg_match('/^(\d{8})(\d{6})(?:\s*([Zz]|[+\-]\d{2}:?\d{2}))?$/', $s, $m)) {
        $date = $m[1]; // YYYYMMDD
        $time = $m[2]; // HHMMSS
        $tz   = $m[3] ?? 'Z';
        $fmt  = substr($date,0,4).'-'.substr($date,4,2).'-'.substr($date,6,2)
              .' '.substr($time,0,2).':'.substr($time,2,2).':'.substr($time,4,2)
              .' '.($tz === 'Z' || $tz === 'z' ? '+0000' : preg_replace('/:/','',$tz));
        $ts2  = strtotime($fmt);
        if ($ts2 !== false) return $ts2;
    }
    return null; // если уж совсем экзотика
}

// ---------- Потоковая валидация/статистика ----------
/**
 * Открываем файл потоково, проверяем корень <tv>, считаем channel/programme,
 * на лету считаем min(start)/max(stop). Ничего большого в память не грузим.
 */
function xmlStreamValidateAndStats($path) {
    $reader = new XMLReader();
    if (!$reader->open($path, null, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING)) {
        return ['valid' => false, 'error' => 'Failed to open XML file'];
    }

    $sawRoot = false;
    $rootIsTv = false;
    $channels = 0;
    $programs = 0;
    $minStart = null;
    $maxStop  = null;

    try {
        while ($reader->read()) {
            if ($reader->nodeType === XMLReader::ELEMENT) {
                if (!$sawRoot) {
                    // Первый стартовый элемент — корень
                    $sawRoot = true;
                    $rootIsTv = (strcasecmp($reader->name, 'tv') === 0);
                    if (!$rootIsTv) {
                        $reader->close();
                        return ['valid' => false, 'error' => 'Not a valid EPG XML (root is not <tv>)'];
                    }
                }

                $name = $reader->name;
                if ($name === 'channel') {
                    $channels++;
                } elseif ($name === 'programme') {
                    $programs++;
                    // парсим атрибуты start/stop, если они есть
                    $start = null; $stop = null;

                    if ($reader->moveToFirstAttribute()) {
                        do {
                            if ($reader->name === 'start') {
                                $start = epgTimeToTs($reader->value);
                            } elseif ($reader->name === 'stop') {
                                $stop  = epgTimeToTs($reader->value);
                            }
                        } while ($reader->moveToNextAttribute());
                        $reader->moveToElement();
                    }

                    if ($start !== null) {
                        $minStart = ($minStart === null) ? $start : min($minStart, $start);
                    }
                    if ($stop !== null) {
                        $maxStop  = ($maxStop  === null) ? $stop  : max($maxStop,  $stop);
                    }
                }
            }
        }
    } catch (Throwable $e) {
        $reader->close();
        return ['valid' => false, 'error' => 'XML parse error: ' . $e->getMessage()];
    }

    $reader->close();

    if (!$rootIsTv) {
        return ['valid' => false, 'error' => 'Not a valid EPG XML (no <tv> root)'];
    }

    $stats = [
        'valid'         => true,
        'channels'      => $channels,
        'programs'      => $programs,
        'file_size'     => @filesize($path) ?: null,
        'last_modified' => @filemtime($path) ?: null,
    ];
    if ($minStart !== null && $maxStop !== null && $maxStop >= $minStart) {
        $stats['date_range'] = [
            'start' => $minStart,
            'end'   => $maxStop,
            'days'  => (int)ceil(($maxStop - $minStart) / 86400)
        ];
    }
    return $stats;
}

// ---------- Загрузка и сохранение (через tmp + атомарный rename) ----------
function updateEpgStream($url, $finalPath, $tmpPath, $maxCompressed, $httpTimeout) {
    // Скачиваем целиком сжатый контент (обычно он кратно меньше 400MB)
    $context = stream_context_create([
        'http' => [
            'timeout'         => $httpTimeout,
            'user_agent'      => 'Mozilla/5.0 (compatible; EPG-Downloader/2.0)',
            'follow_location' => true,
            'max_redirects'   => 3,
        ],
    ]);
    $raw = @file_get_contents($url, false, $context);
    if ($raw === false) {
        $err = error_get_last();
        return ['success' => false, 'error' => 'Download failed: ' . ($err['message'] ?? 'Unknown')];
    }
    if (strlen($raw) > $maxCompressed) {
        return ['success' => false, 'error' => 'Compressed payload too large'];
    }

    // Пытаемся распаковать как GZIP
    $xml = @gzdecode($raw);
    if ($xml === false) {
        // Если источник оказался несжатым XML
        $trim = ltrim($raw);
        if (strlen($trim) > 0 && $trim[0] === '<') {
            $xml = $raw;
        } else {
            return ['success' => false, 'error' => 'Not GZIP and not XML'];
        }
    }

    // Пишем во временный файл
    if (@file_exists($tmpPath) && !@unlink($tmpPath)) {
        return ['success' => false, 'error' => 'Failed to cleanup tmp file'];
    }
    if (@file_put_contents($tmpPath, $xml, LOCK_EX) === false) {
        return ['success' => false, 'error' => 'Failed to write tmp XML'];
    }

    // Потоковая проверка/метрики
    $stats = xmlStreamValidateAndStats($tmpPath);
    if (empty($stats['valid'])) {
        @unlink($tmpPath);
        return ['success' => false, 'error' => $stats['error'] ?? 'Invalid EPG'];
    }

    // Атомарно заменяем старый файл
    if (@rename($tmpPath, $finalPath) === false) {
        // Если rename через разные FS не сработал — попробуем копировать
        if (@copy($tmpPath, $finalPath) === false) {
            @unlink($tmpPath);
            return ['success' => false, 'error' => 'Failed to move XML into place'];
        }
        @unlink($tmpPath);
    }

    return array_merge([
        'success' => true,
        'updated' => time(),
    ], $stats);
}

// ---------- Быстрые статистики по уже сохранённому файлу ----------
function getEpgStatsStream($path) {
    if (!file_exists($path)) return null;
    return xmlStreamValidateAndStats($path);
}

// ---------- Обработка ?default=1 (отдать XML) ----------
if (isset($_GET['default']) && $_GET['default'] == '1') {
    $shouldCache        = shouldCacheEpg($cacheStartHour, $cacheDuration);
    $lastExpectedUpdate = getLastUpdateTime($cacheStartHour, $cacheDuration);
    $needsUpdate        = true;

    if ($shouldCache && file_exists($localEpgPath)) {
        $needsUpdate = (filemtime($localEpgPath) < $lastExpectedUpdate);
    }

    if ($needsUpdate) {
        $res = updateEpgStream($epgUrl, $localEpgPath, $tmpEpgPath, $maxCompressed, $httpTimeout);
        if (empty($res['success'])) {
            header('Content-Type: application/json; charset=utf-8');
            http_response_code(500);
            echo json_encode(['error' => 'EPG not available: ' . $res['error']], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }

    // контрольная проверка
    $stats = getEpgStatsStream($localEpgPath);
    if ($stats && isset($stats['error'])) {
        header('Content-Type: application/json; charset=utf-8');
        http_response_code(500);
        echo json_encode(['error' => $stats['error']], JSON_UNESCAPED_UNICODE);
        exit;
    }

    header('Content-Type: application/xml; charset=utf-8');
    header('Content-Disposition: attachment; filename="epg.xml"');
    header('Cache-Control: public, max-age=3600');
    header('Content-Length: ' . filesize($localEpgPath));
    readfile($localEpgPath);
    exit;
}

// ---------- JSON API ----------
header('Content-Type: application/json; charset=utf-8');

try {
    $shouldCache        = shouldCacheEpg($cacheStartHour, $cacheDuration);
    $lastExpectedUpdate = getLastUpdateTime($cacheStartHour, $cacheDuration);
    $needsUpdate        = true;

    if ($shouldCache && file_exists($localEpgPath)) {
        $needsUpdate = (filemtime($localEpgPath) < $lastExpectedUpdate);
    }

    if ($needsUpdate) {
        $result = updateEpgStream($epgUrl, $localEpgPath, $tmpEpgPath, $maxCompressed, $httpTimeout);
        if (empty($result['success'])) {
            http_response_code(500);
            echo json_encode(['error' => $result['error']], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
            exit;
        }
    } else {
        $stats = getEpgStatsStream($localEpgPath);
        $next  = $lastExpectedUpdate + $cacheDuration;
        $result = [
            'success'              => true,
            'updated'              => filemtime($localEpgPath),
            'cached'               => true,
            'last_expected_update' => gmdate('Y-m-d H:i:s', $lastExpectedUpdate) . ' UTC',
            'next_update'          => gmdate('Y-m-d H:i:s', $next) . ' UTC',
        ];
        if ($stats) $result = array_merge($result, $stats);
    }

    // метаданные
    $nextUpdateTime                 = $lastExpectedUpdate + $cacheDuration;
    $result['format']               = 'xml';
    $result['type']                 = 'epg';
    $result['caching_enabled']      = $shouldCache;
    $result['current_utc_time']     = gmdate('Y-m-d H:i:s') . ' UTC';
    $result['cache_schedule']       = 'Every 2 hours starting from 21:00 UTC, cached for 2 hours each time';
    $result['last_expected_update'] = gmdate('Y-m-d H:i:s', $lastExpectedUpdate) . ' UTC';
    $result['next_update']          = gmdate('Y-m-d H:i:s', $nextUpdateTime) . ' UTC';

    echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['error' => 'Server error: ' . $e->getMessage()], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
}
