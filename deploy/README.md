# Развёртывание готового приложения

Ниже — конфигурация для обычного Linux-сервера с Docker. Можно использовать домен или публичный IPv4.

Нужны Docker Compose, постоянный диск для `/app/data`, поддержка WebSocket и HTTPS. Запускается **один экземпляр, один Python worker**: состояние комнаты хранится в памяти с сохранением в JSON. Горизонтальное масштабирование с этим хранилищем не поддерживается.

## Linux-сервер с публичным IP

Для публичного IPv4 предусмотрен `deploy/Caddyfile.ip`: сертификат Let's Encrypt с автоматическим продлением. Домен покупать не требуется. [IP-сертификаты Let's Encrypt](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability).

После установки Docker и копирования кода создайте `.env.server` (пример, замените IP):

```dotenv
SITE_DOMAIN=203.0.113.10
CADDYFILE=./deploy/Caddyfile.ip
```

Откройте входящие порты 80/TCP и 443/TCP, запустите Compose командой из следующего раздела. Адрес будет `https://ВАШ-IP/`, HTTP перенаправляется на HTTPS. Первичное получение сертификата может занять минуту. Том `caddy-data` нужно сохранять: в нём сертификаты и данные их автоматического продления. На сервере за Docker NAT настроен `default_sni`, чтобы при входе по IP выдавался правильный сертификат.

## Linux-сервер с доменом

1. Установить Docker Engine и Compose по [официальной инструкции](https://docs.docker.com/engine/install/ubuntu/).
2. Скопировать код проекта на сервер. Не копировать локальные `data/`, `work/`, `.env`, `.env.server`, пароли и тестовые ответы. Программа переносится через кнопки пульта.
3. Направить DNS A-запись домена/поддомена на IPv4 сервера. Если есть AAAA, она также должна вести на этот сервер. Разрешить входящие 80/TCP, 443/TCP (443/UDP необязателен). Доступ к SSH сохранить.
4. Скопировать `.env.server.example` в `.env.server`, заменить `SITE_DOMAIN` на свой домен без схемы и пути.
5. Из корня проекта:

```sh
docker compose --env-file .env.server -f compose.server.yaml up --build -d --wait
docker compose --env-file .env.server -f compose.server.yaml exec ludiki cat /app/data/admin-key.txt
```

Открыть `https://ваш-домен/admin`, затем загрузить сохранённую программу. В настройках проверить адрес QR: локальный адрес из импортированного файла нужно заменить на публичный.

`compose.server.yaml` используется самостоятельно, без объединения с `compose.yaml`. Наружу открыт только Caddy; порт приложения 8000 не публикуется. Caddy проксирует WebSocket и получает/обновляет TLS-сертификат для публичного DNS-имени. [Документация HTTPS](https://caddyserver.com/docs/automatic-https), [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Пароль создаётся при первом запуске и сохраняется в томе. Caddy хранит сертификаты в собственном томе. Для обеих служб включены перезапуск после сбоя и ограничение размера логов. Перезапуск контейнера требует повторного входа ведущего; ответы сохраняются.

## Проверить после размещения

С компьютера с установленными зависимостями проекта:

```sh
python scripts/check_ready.py https://ваш-домен
```

Скрипт проверяет страницы, QR и двустороннее WebSocket-соединение, не меняя ответы. Затем необходима проверка с настоящего телефона через мобильную сеть: локальный тест не проверяет доступность выбранного хостинга из аудитории.

```sh
docker compose --env-file .env.server -f compose.server.yaml ps
docker compose --env-file .env.server -f compose.server.yaml logs --tail 50
```

Для обновления кода выполнить `git pull --ff-only`, затем повторить `up --build -d --wait`. Не удалять тома. Не обновлять сервер во время сбора ответов.

## Резерв данных сервера

На Linux-сервере в каталоге проекта; команда копирует текущий JSON, который приложение заменяет атомарно. Отдельно сохраняется пароль. Папка содержит приватные данные, её не надо публиковать вместе с кодом.

```sh
umask 077
backup_dir="backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
docker compose --env-file .env.server -f compose.server.yaml cp ludiki:/app/data/state.json "$backup_dir/state.json"
docker compose --env-file .env.server -f compose.server.yaml cp ludiki:/app/data/admin-key.txt "$backup_dir/admin-key.txt"
```

Для выступления важнее заранее подготовить отдельную локальную копию по `RUNBOOK.md`. Копия программы и резерв полного состояния — разные вещи.
