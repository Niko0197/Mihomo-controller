#!/bin/sh

# ============================================
#   Mihomo Controller — Установка / Обновление
# ============================================

GITHUB_USER="Niko0197"
REPO_NAME="Mihomo-controller"
BRANCH="main"

INSTALL_DIR="/opt/root/mihomo-controller"
INIT_SCRIPT="/opt/etc/init.d/S99mihomo-controller"
TEMP_TAR="/tmp/mihomo-controller.tar.gz"
TEMP_DIR="/tmp/$REPO_NAME-$BRANCH"

# Определение режима (install / update)
MODE="install"
if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/server.js" ]; then
    MODE="update"
fi

# Принудительный режим через аргумент
if [ "$1" = "update" ]; then
    MODE="update"
elif [ "$1" = "install" ]; then
    MODE="install"
fi

echo "========================================="
if [ "$MODE" = "update" ]; then
    echo "   Обновление Mihomo Controller"
else
    echo "   Установка Mihomo Controller на Keenetic"
fi
echo "========================================="

# 1. Проверка Entware
if [ ! -d "/opt" ]; then
    echo "✗ Ошибка: Entware не обнаружен! Убедитесь, что Entware установлен на роутере."
    exit 1
fi

# 2. Установка зависимостей (только при install)
if [ "$MODE" = "install" ]; then
    echo "→ Шаг 1: Проверка и установка зависимостей (Node.js, curl, tar)..."
    opkg update

    if ! command -v node >/dev/null 2>&1; then
        echo "  Устанавливаем Node.js..."
        opkg install node
    fi

    if ! command -v curl >/dev/null 2>&1; then
        echo "  Устанавливаем curl..."
        opkg install curl
    fi

    if ! command -v tar >/dev/null 2>&1; then
        echo "  Устанавливаем tar..."
        opkg install tar
    fi
else
    echo "→ Шаг 1: Зависимости уже установлены, пропускаем."
fi

# 3. Скачивание исходников
echo "→ Шаг 2: Скачивание Mihomo Controller с GitHub..."
mkdir -p /opt/root

curl -sL "https://github.com/$GITHUB_USER/$REPO_NAME/archive/refs/heads/$BRANCH.tar.gz" -o "$TEMP_TAR"

if [ ! -f "$TEMP_TAR" ]; then
    echo "✗ Ошибка: Не удалось скачать файлы с GitHub."
    exit 1
fi

# Распаковываем во временную директорию
rm -rf "$TEMP_DIR"
tar -xzf "$TEMP_TAR" -C /tmp/
rm -f "$TEMP_TAR"

if [ ! -d "$TEMP_DIR" ]; then
    echo "✗ Ошибка: Не удалось распаковать архив."
    exit 1
fi

# 4. Установка или обновление
if [ "$MODE" = "update" ]; then
    echo "→ Шаг 3: Обновление файлов (пользовательские данные сохраняются)..."

    # Останавливаем службу перед обновлением
    if [ -f "$INIT_SCRIPT" ]; then
        echo "  Останавливаем службу..."
        "$INIT_SCRIPT" stop 2>/dev/null
        sleep 1
    fi

    # Обновляем только код приложения, НЕ трогая пользовательские данные
    # Список файлов кода для обновления:
    for FILE in server.js updater.js clients_manager.js system_stats.js yaml_utils.js install.sh; do
        if [ -f "$TEMP_DIR/$FILE" ]; then
            cp -f "$TEMP_DIR/$FILE" "$INSTALL_DIR/$FILE"
            echo "  ✓ Обновлён: $FILE"
        fi
    done

    # Обновляем фронтенд полностью
    if [ -d "$TEMP_DIR/public" ]; then
        rm -rf "$INSTALL_DIR/public"
        cp -rf "$TEMP_DIR/public" "$INSTALL_DIR/public"
        echo "  ✓ Обновлён: public/ (веб-интерфейс)"
    fi

    # Обновляем README
    if [ -f "$TEMP_DIR/README.md" ]; then
        cp -f "$TEMP_DIR/README.md" "$INSTALL_DIR/README.md"
    fi

    # Обновляем .gitignore
    if [ -f "$TEMP_DIR/.gitignore" ]; then
        cp -f "$TEMP_DIR/.gitignore" "$INSTALL_DIR/.gitignore"
    fi

    echo ""
    echo "  Сохранены без изменений:"
    echo "    • clients_db.json (база клиентов)"
    echo "    • tor_bridges.json (Tor-мосты)"
    echo "    • log.txt, *.log (логи)"
    echo "    • config.yaml.bak (бэкап конфига)"

else
    echo "→ Шаг 3: Чистая установка..."

    # Очищаем старую версию если есть
    rm -rf "$INSTALL_DIR"

    # Перемещаем из временной директории
    mv "$TEMP_DIR" "$INSTALL_DIR"

    echo "  ✓ Файлы установлены в $INSTALL_DIR"
fi

# Удаляем временные файлы
rm -rf "$TEMP_DIR"

# 5. Создание/обновление службы автозапуска
echo "→ Шаг 4: Настройка службы автозапуска..."

cat << 'EOF' > "$INIT_SCRIPT"
#!/bin/sh

ENABLED=yes
PROCS=/opt/bin/node
ARGS="/opt/root/mihomo-controller/server.js"
PREARGS=""
DESC="mihomo-controller"
PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

. /opt/etc/init.d/rc.func
EOF

chmod +x "$INIT_SCRIPT"

# 6. Запуск веб-панели
echo "→ Шаг 5: Запуск Mihomo Controller..."
if [ -f "$INIT_SCRIPT" ]; then
    "$INIT_SCRIPT" restart
fi

echo ""
echo "========================================="
if [ "$MODE" = "update" ]; then
    echo "  ✓ Обновление успешно завершено!"
else
    echo "  ✓ Установка успешно завершена!"
fi
echo ""
echo "  Панель управления доступна по адресу:"
echo "  http://192.168.1.1:4000"
echo "========================================="
