<?php
// Конфигурация
$playlistUrl = 'https://m3u.su/sh';
$localPlaylistPath = 'tv.m3u';
$cacheTime = 3600 * 6; // 6 часа кэширования

// Функция для скачивания и сохранения плейлиста (объявляем ОДИН раз!)
function updatePlaylist($url, $path) {
    $content = @file_get_contents($url);
    if ($content === false) {
        return ['success' => false, 'error' => 'Failed to download playlist'];
    }

    $saved = file_put_contents($path, $content);
    if ($saved === false) {
        return ['success' => false, 'error' => 'Failed to save playlist'];
    }

    return ['success' => true, 'updated' => time()];
}

// Если запрошен default плейлист - отдаём tv.m3u
if (isset($_GET['default']) && $_GET['default'] == '1') {
    // Проверяем и обновляем плейлист при необходимости
    if (!file_exists($localPlaylistPath) || time() - filemtime($localPlaylistPath) > $cacheTime) {
        $result = updatePlaylist($playlistUrl, $localPlaylistPath);
        if (!$result['success'] && !file_exists($localPlaylistPath)) {
            header('Content-Type: application/json');
            echo json_encode(['error' => 'Playlist not available']);
            exit;
        }
    }

    // Отдаём плейлист как файл
    header('Content-Type: audio/x-mpegurl');
    header('Content-Disposition: attachment; filename="tv.m3u"');
    readfile($localPlaylistPath);
    exit;
}

// Оригинальный JSON-функционал (если нужно)
header('Content-Type: application/json');

// Проверяем, нужно ли обновить плейлист
if (!file_exists($localPlaylistPath) || time() - filemtime($localPlaylistPath) > $cacheTime) {
    $result = updatePlaylist($playlistUrl, $localPlaylistPath);
    if (!$result['success']) {
        // Если не удалось обновить, но файл существует - используем старый
        if (file_exists($localPlaylistPath)) {
            $result = ['success' => true, 'updated' => filemtime($localPlaylistPath), 'cached' => true];
        }
    }
} else {
    $result = ['success' => true, 'updated' => filemtime($localPlaylistPath), 'cached' => true];
}

// Возвращаем результат
echo json_encode($result);
?>