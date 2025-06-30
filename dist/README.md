# Venom player

Бесплатный DASH HLS HTML5 видео плеер для сайта

Пример:

```html

<script src="https://cdn.jsdelivr.net/npm/venom-player@latest"></script>
<script>
    VenomPlayer.make({
        publicPath: 'https://cdn.jsdelivr.net/npm/venom-player@' + VenomPlayer.version + '/dist/',
        source: {
            file: {
                360: 'https://raw.githubusercontent.com/mnaseersj/BigBuckBunny/master/BigBuckBunny_640x360.mp4'
            }
        }
    })
</script>
```

## Краткое содержание
* [Параметры](#parameters)
* [События](#events)
* [Методы и свойства](#methods)
* [Список воспроизведения](#playlist)
* [Модуль рекламы](#ads)
* [Надписи и текст сообщений по умолчанию](#text)


<a name="parameters"></a>
## Параметры
`publicPath` (_String_) задаёт базовый путь, откуда будут подгружаться по мере
необходимости динамические модули. Например, если плеер подключен из
https://cdn.jsdelivr.net/npm/venom-player@latest, то нужно указать
`"https://cdn.jsdelivr.net/npm/venom-player@latest/dist/"`

`source` (_Object_) комплексный параметр, в основном для указания пути к 
источнику видео. Должна содержать хотя бы одну из секций:

* `dash` (_String_) путь к dash манифесту
* `hls` (_String_) путь к hls манифесту
* `file` (_Object<Number,String>_) объект, в котором ключом выступает качество видео, а значением - путь к медиа файлу (
  mp4, webm и т.д.)

Эти опции должны представлять альтернативные варианты одного и того же видео. Если указан `dash`, но он не
поддерживается браузером пользователя, то будет использован `hls`; если же нет поддержки hls (библиотеки hls.js или же
нативной), воспроизводиться будет `file`

Пример:

```javascript
opts = {
 // ...
 source: {
  dash: 'https://video.example/id/master.mpd',
  hls: 'https://video.example/id/master.m3u8'
 }
}
```

***
* `source.audio` позволяет переименовывать звуковые дорожки и изменять их порядок в меню
(количество должно совпадать с манифестом, иначе параметр будет проигнорирован)
* `source.cc` субтитры
```javascript
opts = {
  // ...
  source: {
    // ...
    audio:  {
      names: ["Оригинал", "Дубляж"],
      order: [1, 0] // в меню будет "Дубляж", а затем "Оригинал" 
    },
    cc: {
      { name: "rus", url: "https://example.cc/rus.vtt" },
      { name: "eng", url: "https://example.cc/eng.vtt" }
    }
  }
}
```

`container` (_Element_) - ссылка на DOM элемент, в который следует встроить
плеер. Если не указан, будет использовано `document.body`.
Перед встраиванием весь контент контейнера будет очищен.
```javascript
container: document.getElementById('player-container')
```

`title` (_String_) - название видео. Не отображается в теме "classic"
```javascript
title: 'Game of Thrones'
```

`ui.titleOnlyOnFullscreen` (_Boolean_) если включена, то название видео будет
отображаться только в полноэкранном режиме
```javascript
ui: {
    titleOnlyOnFullscreen: true
}
```

`poster` (_String_) путь к постеру. Подробнее про poster [тут](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video)

`defaultPoster` (_String_) заглушка, которая будет использована как постер,
если изображение из параметра `poster` по каким-либо причинам будет недоступно.

`autoLandscape` (_Boolean_) если установить `true`, то на мобильных при входе в
полноэкранный режим также будет использована альбомная ориентация экрана

`pip` (_Boolean | Number_) `true` - добавить кнопку "picture in picture",
по умолчанию `false`. При значении `0.5` переход в этот режим будет происходить
автоматически, когда видимость плеера станет ниже 50%

`live` (_Boolean_) для трансляций следует указать `live: true`

`liveBuffer` соответствует настройке *hls.js* `maxBufferLength`

`theme` (_String_) тема, в данный момент доступны "modern", "classic", "metro". По умолчанию "venom"

<a name="css-vars"></a>
`cssVars` (_Object_) позволяет более тонко настроить вид плеера. Значения можно обновить после инициализации с
помощью [сеттера](#set-css-vars)
TODO list

`aspectRatio` (_String_) соотношение сторон, по умолчанию `"16:9"`. Значение `"fill"` (заполнить всё доступное
пространство) или "ширина:высота"
(4:3, 10:9, 1:1...)

`blocked` (_Boolean_) если установлено в `true`, вместо плеера будет выведено
окно-заглушка с сообщением, что видео заблокировано. Текст сообщения можно
изменить с помощью `text.blocked`

`quality` (_Number_) качество по умолчанию
```javascript
quality: 720
```

`restrictQuality` (_Function_) позволяет ограничить качество. Вместо смены будет
выведено сообщение, что вернула функция. Если результат в логическом контексте
ложен - ограничений нет.
```javascript
restrictQuality: function(quality) {
  if (quality > 9000) {
    return "Your video card are not prepared!"
  }
}
```

`speed` (_Number[]_) список значений, из которых пользователь сможет выбрать
скорость воспроизведения
```javascript
speed: [1, 1.1, 1.25, 1.5]
```

`restrictSpeed` (_Function_) позволяет ограничить изменение скорости
воспроизведения, в зависимости от качества
```javascript
restrictSpeed: function(rate, quality) {
  if (rate > 1 && quality > 480) {
    return 'Ускорение доступно только для низкого качества видео'
  }
}
```

`volume` (_Number_) звук в пределах от `0` до `1`. По умолчанию `1`

`time` (_Number_) начать воспроизведения с указанного времени в секундах

`timeSearchParamName` (_String_) название get параметра, с которого будет взято
 значение `time`, по умолчанию `"t"`
 
`trackProgress` (_Number_) интервал в секундах, по которому будет срабатывать 
событие `viewProgress`, по умолчанию `60`

`doNotSaveProgress` (_Boolean_) if `true` then don't save progress to localStorage,
по умолчанию `false`

`rewind` (_Number[]_) время перемотки в секундах, по умолчанию `[5, 20]`. Первое
значение используется при перемотке стрелками клавиатуры и тапом на мобильном
(можно несколько раз подряд), второе - с зажатой кнопкой _shift_ и на телевизоре

`replay` повторять воспроизведение

`download` (_String_) позволяет добавить ссылку на скачивание

`reportUrl` (_String_) url, на который будет отправляться форма обратной связи
методом POST. Содержит поля: email, message и data

`dash` (_Object_) настройки dashjs, [подробнее](http://cdn.dashjs.org/latest/jsdoc/module-MediaPlayer.html#updateSettings__anchor)

```javascript
ui: {
    // share: false, // спрятать кнопку поделиться, по умолчанию true
    // share: ['facebook', 'vkontakte', 'odnoklassniki', 'copy'], // белый список
    // timeline: false, // по умолчанию true
    // prevNext: false, // по умолчанию true: спрятать кнопки "следующая"/"предыдущая"
    // fullscreen: 'external'|false, по умолчанию true
}
```

`text`, `translations` изменить [надписи](#text)
```javascript
text: {
    settings: 'Настройки'
},
translations: { // позволяет изменить или дополнить переводы
    en: {
        settings: '[ Settings ]'
    }
}
```

`format` (_Object_) форматирование опций меню
```javascript
format: {
    speed: function (rate) {
        return 'x' + rate;
    },
    quality: function (q) {
        if (q > 2000) return q+'K';
        if (q > 1079) return 'fHD '+q;
        if (q > 719) return 'HD '+q;
        return q;
    }
}
```

`preview` TODO

`oneSound` (_String_) позволяет спрятать все звуковые дорожки, кроме указанной
```javascript
oneSound: 'original' // регистронезависимо; можно указать лишь часть названия
```

`soundBlock` (_String_) спрятать перечисленные звуковые дорожки
```javascript
soundBlock: 'spanish,одноголосый' // можно указать лишь часть названия
```

<a name="events"></a>
## События
Поддерживаются стандартные [медиа события](https://developer.mozilla.org/en-US/docs/Web/Guide/Events/Media_events)
и события VPAID, а также:
* `ready` информирует о завершении инициализации
* `endedSoon` воспроизведение скоро закончится. Срабатывает за 20 сек до конца видео,
но это время можно изменить с помощью одноименного параметра `endedSoon`. На это
событие показывается подсказка о переключении на следующую серию; его же следует
использовать, чтобы показать рекомендации или отправлять событие окончания просмотра
в статистику (следующее видео из списка воспроизведения может быть переключено до
события "_ended_", во время титров)
* `playlistItem` срабатывает перед переключением видео в списке воспроизведения. В
зависимости от типа списка может содержать _id, season, episode_
* `selectRecommendation` id выбранной рекомендации (см. метод
[showRecommendations](#showRecommendations))
* TODO

<a name="methods"></a>
## Методы и свойства

* `on()`, `once()`, `off()` аналогичны [EventEmitter node.js](https://nodejs.org/api/events.html)
  <a name="showRecommendations"></a>
* `showRecommendations()` показать рекомендации; id выбранной можно получить с помощью события `selectRecommendation`
```javascript
player.once('endedSoon', () => player.showRecommendations([
    { id: 1, name: 'title1', poster: '<url1>' },
    { id: 2, name: 'title2', poster: '<url2>' },
    { id: 3, name: 'title3', poster: '<url3>' }
]));
player.on('selectRecommendation', id => alert(`go to video with id ${id}`));
```
* `onRenew` callback, вызываемый при реинициализации плеера (переключение видео
из списка воспроизведения, иногда попытка таким образом исправить ошибку). Следует
использовать для подписки на события нового плеера. Пример:

```javascript
var player = VenomPlayer.make({ /*...*/ });
player.onRenew = listen;
listen(player);

function listen(player) {
	player.once('ready', () => console.log('player ready'));
}
```

* `cssVars` сеттер для обновления [cssVars](#css-vars) <a name="set-css-vars"></a>

```javascript
player.cssVars = {
	'color-primary': '#12aa6a',
	'background-color-primary': 'rgba(27, 39, 52, .9)'
};
```

### Статические

* `version` (_String_) текущая версия плеера
* `isMobile` (_Boolean_)
* `VenomPlayer.cssVars()` реэкспорт пакета [css-vars-ponyfill](https://www.npmjs.com/package/css-vars-ponyfill)

<a name="playlist"></a>

## Список воспроизведения

* `playlist` (_Object_ | _String_) объект или url списка воспроизведения; в случае использования url формат должен быть
  json

Списков есть 2 вида: обычный "плоский" (одно уровневый)

```javascript
playlist: {
    open: false,
    autoNext: true,
    ignoreLast: false,
    id: 'playlist id',
    flat: [
        { id: 'video1', title: 'title 1', source: { /*...*/ }, blocked: false },
        { id: 'video2', title: 'title 2', source: { /*...*/ } }
    ],
    current: { id: 'video1' }
}
```

и вложенный (для сериалов)
```javascript
playlist: {
    id: 'game-of-thrones',
    seasons: [{
        season: 1, blocked: false, episodes: [
            { episode: '1', id: 'got1e1', title: 's1e1', source: { /*...*/ }, poster: '' },
            { episode: '2', id: 'got1e2', title: 's1e2', source: { /*...*/ }, mini: '' },
            { episode: '3', id: 'got1e3', title: 's1e3', source: { /*...*/ }, blocked: false }
        ]
    }, {
        season: 2, episodes: [/*...*/]
    }],
    current: { season: 2, episode: '13' }
}
```

### параметры списка воспроизведения
`id` уникальный идентификатор списка, по нему будет сохраняться позиция просмотра

`flat` массив [эпизодов](#episode) ИЛИ `seasons` массив [сезонов](#season)

`current` позиция списка, с которой следует начать проигрывание, для `flat`
следует указать идентификатор видео `{ id: 'video id' }`, для `seasons` -
сезон и серию `{ season: 2, episode: '13' }`

`open` если установить в `true` - меню списка будет изначально открыто
(работает только в теме **"modern"**)
 
`autoNext: false` - отключить автоматическое переключение на следующий эпизод

`ignoreLast: true` - игнорировать сохраненную позицию, на которой остановился
пользователь. Вместо этого будет показан эпизод, установленный параметром `current`

### параметры сезона <a name="season"></a>
`season` номер сезона

`blocked` если значение `true` - все эпизоды этого сезона также будут
недоступны для просмотра

`episodes` список [эпизодов](#episode)

### параметры эпизода <a name="episode"></a>
`id` уникальный идентификатор видео

`episode` номер эпизода (серии)

`source`, `title`, `blocked` и `poster` аналогичны параметрам плеера

`mini` миниатюра постера, отображаемая при наведении на копки "Следующая"/"Предыдущая"

<a name="ads"></a>
## Модуль рекламы
Настраивается с помощью параметра `ads`. Поведение по умолчанию:

`start => pre roll ( => 10m => non linear => 5m => middle )`*

*поведение, заключенное в скобки, повторяется

```javascript
ads: {
    volume: 0.3, // 30% громкости, чтобы сгладить контраст с контентом
    midThenNonLinear: false, // true - показать первым middle roll, затем оверлэй
    nonLinear: { // overlay
        url: 'https://...',
        offset: 10 * 60, // через 10 мин после старта и middle
        total: 2 // общее количество не больше 2 (по умолчанию не ограничено)
    },
    pre: {
        urls: ['https://...'], //ссылка на vast
        maxImpressions: 2 // не больше 2 подряд
    },
    middle: {
        urls: ['https://...'],
        maxImpressions: 1, // не больше 1 подряд
        offset: 5 * 60, // через 5 мин после non-linear (overlay)
        total: 0 // общее количество не ограничено
    }
}
```

---

## text
| ключ | значение по умолчанию |
|---:|---|
|themeWrongVersion| версия темы не совпадает с версией плеера|
|themeLoadFailed| не удалось загрузить тему|

| ключ | значение по умолчанию |
|---:|---|	
|blocked| Видео заблокировано|
|mute| Отключить звук (m)|
|unMute| Включить звук (m)|
|pause| Пауза (пробел)|
|play| Смотреть (пробел)\nили клик в любом месте|
|fullscreenEnter| Полноэкранный режим (f)|
|fullscreenExit| Выход из полноэкранного режима (f)|
|pipIn| Режим "картинка в картинке"|
|pipOut| Выйти c режима "картинка в картинке"|
|settings| Настройки|
|quality| Качество|
|sound| Озвучка|
|speed| Скорость|
|cc| Субтитры|
|off| Откл|
|playlist| Список воспроизведения|
|emptyList| Список пуст.|
|Season| Сезон|
|season| сезон|
|episode| серия|
|episodes| Серии|
|next| Следующая|
|prev| Предыдущая|
|select| Выбрать|
|seconds| секунд|
|back| назад|
|nextIn| Следующая серия запустится через|
|report| Сообщить о проблеме|
|describeProblem| Опишите проблему|
|email| Email|
|cancel| Отмена|
|submit| Отправить|
|copy| Копировать|
|share| Поделиться ссылкой|
|shareWith| Поделиться с помощью|
|copyUrl| Копировать URL видео|
|copyWithTime| Копировать URL видео с привязкой ко времени|
|skipAd| Пропустить рекламу|
|after| \nможно через|
|sec| сек|
|online| Онлайн|
|goLive| В онлайн|
