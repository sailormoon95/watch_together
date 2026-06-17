# Watch Together

MVP веб-приложения для совместного просмотра фильма или сериала по короткой ссылке без авторизации зрителей.

## Возможности

- Админка `/watch/admin` защищена паролем из `.env`.
- Загрузка фильма: название + один файл.
- Загрузка сериала: название + количество серий + название и файл каждой серии.
- Для фильма создается отдельная директория с названием фильма.
- Для сериала создается директория сериала, внутри нее директории серий с номером и названием.
- Удаление фильма, сериала или отдельной серии из админки.
- Фоновая подготовка видео через `ffprobe`/`ffmpeg` в `MP4 H.264/AAC`.
- Комната просмотра `/watch/r/<code>` по короткому коду, например `AB7K2Q`.
- Для сериала одна ссылка ведет в комнату сериала, выбор серии синхронизируется у всех.
- Видео отдается только через валидный код комнаты.
- Поддержка HTTP `Range` для перемотки и буферизации.
- Синхронизация `play`, `pause`, `seek`, выбора серии через WebSocket.
- Коррекция небольшого рассинхрона через `playbackRate`.
- Камера и микрофон по желанию через LiveKit SFU.
- Полноэкранный режим фильма с правой полосой видео участников.
- Интерфейс рассчитан на ноутбук, телефон и ТВ.
- Расширенные структурные логи для отладки.
- Docker logs ограничены 200 МБ: `20m x 10 files`.

## Где брать ссылку

В админке после обработки фильма или сериала нажмите `Создать ссылку`. Админка покажет короткий код и полный URL вида:

```text
https://plugin-ai.ru/watch/r/AB7K2Q
```

На главной `/watch` также можно ввести короткий код комнаты вручную.

## Стек

- Node.js 22
- TypeScript
- Fastify
- JSON-хранилище на диске для MVP
- React + Vite
- ffmpeg/ffprobe
- WebSocket + LiveKit

## Локальный запуск

```bash
cp .env.example .env
npm install
npm run build
npm start
```

Открыть:

```text
http://localhost:3000/watch/admin
```

Для разработки можно запустить отдельно backend и Vite:

```bash
npm run dev:server
npm run dev:client
```

## Переменные окружения

```text
WATCH_ADMIN_PASSWORD=change-me
WATCH_SESSION_SECRET=change-me-to-a-long-random-string
WATCH_PUBLIC_BASE_URL=https://plugin-ai.ru/watch
WATCH_DATA_DIR=./data
WATCH_HOST=0.0.0.0
WATCH_PORT=3000
WATCH_LOG_LEVEL=debug
WATCH_COOKIE_SECURE=true
WATCH_MAX_UPLOAD_MB=8192
WATCH_SESSION_TTL_HOURS=24
WATCH_LIVEKIT_URL=wss://plugin-ai.ru/livekit
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=change-me-to-a-long-random-string
# Опционально для production: Node авторизует, Nginx отдает видео через X-Accel-Redirect.
# WATCH_VIDEO_ACCEL_REDIRECT_PREFIX=/watch-internal-media/
# WATCH_VIDEO_ACCEL_FILE_PREFIX=/data/media
```

## Docker

```bash
cp .env.example .env
docker compose build
docker compose up -d
```

По умолчанию контейнер приложения слушает локально на `127.0.0.1:3012`, чтобы reverse proxy отдавал приложение под `https://plugin-ai.ru/watch`.
LiveKit signaling слушает локально на `127.0.0.1:7880`, а media ports открываются напрямую: `7881/tcp` и `50000-50100/udp`.

## Reverse Proxy

Нужно прокинуть `/watch` на `http://127.0.0.1:3012`, сохранить WebSocket upgrade для `/watch/ws` и прокинуть LiveKit signaling `/livekit/` на `http://127.0.0.1:7880/`.
Для плавной отдачи больших видео в production лучше включить `X-Accel-Redirect`: Node проверяет код комнаты, а Nginx отдает файл с поддержкой `Range` и `sendfile`.

Пример Nginx:

```nginx
location /watch/ {
    proxy_pass http://127.0.0.1:3012;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    client_max_body_size 8192m;
}

location = /watch {
    return 301 /watch/;
}

location /livekit/ {
    proxy_pass http://127.0.0.1:7880/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}

location ^~ /watch-internal-media/ {
    internal;
    alias /opt/watch_together/data/media/;
    sendfile on;
    tcp_nopush on;
    aio threads;
    add_header Cache-Control "no-store" always;
    types { video/mp4 mp4; }
    default_type video/mp4;
}
```

Для длинной загрузки больших файлов может понадобиться увеличить proxy timeout/body size в текущем reverse proxy.
Для LiveKit нужно открыть на сервере `7881/tcp` и `50000-50100/udp`, иначе камеры/микрофоны не смогут передавать media traffic.

## Хранение данных

```text
data/store.json
data/incoming
data/media
```

Эти данные не коммитятся в git.

## Ограничения MVP

- Зрители без авторизации, безопасность ссылки держится на коротком случайном коде комнаты.
- Браузер может заблокировать удаленный автозапуск видео до первого пользовательского взаимодействия.
- Абсолютная кадровая синхронизация невозможна, но приложение стремится держать рассинхрон в пределах долей секунды.
