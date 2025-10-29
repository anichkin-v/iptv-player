<?php
// Конфигурация
$playlistUrl = 'https://raw.githubusercontent.com/Spirt007/Tvru/refs/heads/Master/Rus.m3u';
$localPlaylistPath = 'tva.m3u';
$cacheTime = 3600 * 6; // 6 часов кэширования

/**
 * Удаляет все #EXTM3U (в т.ч. с параметрами) и добавляет ровно один пустой #EXTM3U в начало.
 * Также убирает UTF-8 BOM и лишние пустые строки в начале.
 */
function normalizePlaylistContent(string $content): string {
    // Убираем BOM (если есть)
    if (substr($content, 0, 3) === "\xEF\xBB\xBF") {
        $content = substr($content, 3);
    }

    // Приводим переводы строк к \n (для удобства обработки)
    $content = str_replace(["\r\n", "\r"], "\n", $content);

    // Удаляем все строки, начинающиеся с #EXTM3U (с параметрами или без)
    // флаг 'm' — построчный режим, 'i' — регистронезависимо на всякий
    $content = preg_replace('/^\s*#EXTM3U.*\n?/mi', '', $content);

    // Удаляем пустые строки и пробелы в начале файла
    $content = ltrim($content);

    // Склеиваем обратно, гарантируя один #EXTM3U и перевод строки после него
    $normalized = "#EXTM3U\n";
    if ($content !== '') {
        // Если первая строка снова #EXTMINF/EXTINF и т.п. — просто дописываем как есть
        $normalized .= $content;
        // Гарантируем завершающий перевод строки (не обязательно, но аккуратнее)
        if (!str_ends_with($normalized, "\n")) {
            $normalized .= "\n";
        }
    }
    return $normalized;
}

/**
 * Скачивает, нормализует и сохраняет плейлист.
 */
function updatePlaylist(string $url, string $path): array {
    $content = @file_get_contents($url);
    if ($content === false) {
        return ['success' => false, 'error' => 'Failed to download playlist'];
    }

    $content = normalizePlaylistContent($content);

    $saved = @file_put_contents($path, $content);
    if ($saved === false) {
        return ['success' => false, 'error' => 'Failed to save playlist'];
    }

    return ['success' => true, 'updated' => time()];
}

/**
 * Гарантирует, что уже сохранённый файл нормализован.
 * Если требуется, перезаписывает его нормализованной версией.
 */
function ensureNormalizedFile(string $path): void {
    if (!file_exists($path)) return;
    $current = @file_get_contents($path);
    if ($current === false) return;

    $normalized = normalizePlaylistContent($current);
    if ($normalized !== $current) {
        @file_put_contents($path, $normalized);
        @touch($path); // Обновим mtime, раз уж правили
    }
}

// ===== Режим "отдать default плейлист" (как файл) =====
if (isset($_GET['default']) && $_GET['default'] == '1') {
    // Проверяем и обновляем/нормализуем плейлист при необходимости
    if (!file_exists($localPlaylistPath) || time() - filemtime($localPlaylistPath) > $cacheTime) {
        $result = updatePlaylist($playlistUrl, $localPlaylistPath);
        if (!$result['success'] && !file_exists($localPlaylistPath)) {
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['error' => 'Playlist not available'], JSON_UNESCAPED_UNICODE);
            exit;
        }
    } else {
        // На всякий случай дожмём нормализацию старого кэша
        ensureNormalizedFile($localPlaylistPath);
    }

    // Отдаём как файл
    header('Content-Type: audio/x-mpegurl; charset=utf-8');
    header('Content-Disposition: attachment; filename="tv.m3u"');
    readfile($localPlaylistPath);
    exit;
}

// ===== JSON API: обновление/проверка состояния =====
header('Content-Type: application/json; charset=utf-8');

if (!file_exists($localPlaylistPath) || time() - filemtime($localPlaylistPath) > $cacheTime) {
    $result = updatePlaylist($playlistUrl, $localPlaylistPath);
    if (!$result['success']) {
        // Если не удалось обновить, но файл существует — нормализуем его и возвращаем как кэш
        if (file_exists($localPlaylistPath)) {
            ensureNormalizedFile($localPlaylistPath);
            $result = ['success' => true, 'updated' => filemtime($localPlaylistPath), 'cached' => true];
        }
    }
} else {
    // Файл свежий — убедимся, что он нормализован
    ensureNormalizedFile($localPlaylistPath);
    $result = ['success' => true, 'updated' => filemtime($localPlaylistPath), 'cached' => true];
}

echo json_encode($result, JSON_UNESCAPED_UNICODE);
