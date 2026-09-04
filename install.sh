#!/bin/sh

# ============================================
#   Mihomo Controller — Установка / Обновление
# ============================================

GITHUB_USER="Niko0197"
REPO_NAME="Mihomo-controller"
BRANCH="${BRANCH:-main}"

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
    echo "→ Шаг 1: Проверка и установка зависимостей (Node.js, curl, tar, gzip, ca-certificates)..."
    opkg update

    for PKG in node curl tar gzip ca-certificates; do
        if [ "$PKG" = "ca-certificates" ]; then
            opkg install ca-certificates 2>/dev/null || true
        elif ! command -v "$PKG" >/dev/null 2>&1; then
            echo "  Устанавливаем $PKG..."
            opkg install "$PKG"
        fi
    done
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

# 4. Установка или обновление файлов проекта
if [ "$MODE" = "update" ]; then
    echo "→ Шаг 3: Обновление файлов (пользовательские данные сохраняются)..."

    # Останавливаем службу перед обновлением
    if [ -f "$INIT_SCRIPT" ]; then
        echo "  Останавливаем службу..."
        "$INIT_SCRIPT" stop 2>/dev/null
        sleep 1
    fi

    # Обновляем только код приложения, НЕ трогая пользовательские данные
    for FILE in server.js panel_logger.js updater.js clients_manager.js system_stats.js yaml_utils.js dpi_manager.js install.sh uninstall.sh; do
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

    if [ -f "$TEMP_DIR/README.md" ]; then
        cp -f "$TEMP_DIR/README.md" "$INSTALL_DIR/README.md"
    fi

    if [ -f "$TEMP_DIR/.gitignore" ]; then
        cp -f "$TEMP_DIR/.gitignore" "$INSTALL_DIR/.gitignore"
    fi

    echo ""
    echo "  Сохранены без изменений:"
    echo "    • clients_db.json (база клиентов)"
    echo "    • clients_rules.yaml (правила устройств)"
    echo "    • app_mode.json (режим работы роутера)"
    echo "    • traffic_db.json (статистика трафика)"
    echo "    • dpi_settings.json (настройки DPI и замочков)"
    echo "    • log.txt, *.log (логи)"
    echo "    • /opt/etc/mihomo/config.yaml (текущая конфигурация)"

else
    echo "→ Шаг 3: Чистая установка..."

    rm -rf "$INSTALL_DIR"
    mv "$TEMP_DIR" "$INSTALL_DIR"

    echo "  ✓ Файлы установлены в $INSTALL_DIR"
fi

rm -rf "$TEMP_DIR"

# 5. Установка и настройка встроенного DPI-Bypass (ByeDPI SOCKS5)
echo "→ Шаг 4: Настройка встроенного DPI-Bypass для YouTube (2 независимых службы SOCKS5)..."

# Точное определение архитектуры через opkg и uname
OPKG_ARCH=$(opkg print-architecture 2>/dev/null | grep -v 'arch all' | sort -k3 -n | tail -n1 | awk '{print $2}')
UNAME_M=$(uname -m 2>/dev/null)

DPI_ARCH=""
case "$OPKG_ARCH" in
    aarch64*|arm64*) DPI_ARCH="aarch64" ;;
    armv7*|armhf*|cortex*) DPI_ARCH="armv7l" ;;
    armv6*) DPI_ARCH="armv6" ;;
    mipsel*|mipsle*) DPI_ARCH="mipsel" ;;
    mips*) DPI_ARCH="mips" ;;
    x86_64*|amd64*) DPI_ARCH="x86_64" ;;
    i*86) DPI_ARCH="i686" ;;
esac

if [ -z "$DPI_ARCH" ]; then
    case "$UNAME_M" in
        aarch64|arm64) DPI_ARCH="aarch64" ;;
        armv7*|armhf) DPI_ARCH="armv7l" ;;
        armv6*) DPI_ARCH="armv6" ;;
        mipsel|mipsle) DPI_ARCH="mipsel" ;;
        mips*) DPI_ARCH="mipsel" ;; # Для роутеров Keenetic MIPS дефолт - mipsel (MT7621/MT7628)
        x86_64|amd64) DPI_ARCH="x86_64" ;;
        i*86) DPI_ARCH="i686" ;;
        *) DPI_ARCH="aarch64" ;;
    esac
fi

echo "  Определена целевая архитектура: $DPI_ARCH"
mkdir -p /opt/bin /opt/var/run

NEED_DOWNLOAD=1
if [ -f "/opt/bin/ciadpi" ]; then
    if /opt/bin/ciadpi -h >/dev/null 2>&1 || /opt/bin/ciadpi --help >/dev/null 2>&1; then
        echo "  ✓ Установленный бинарник ByeDPI (/opt/bin/ciadpi) проверен и готов к работе."
        NEED_DOWNLOAD=0
    else
        echo "  ⚠️ Текущий бинарник ciadpi поврежден или не соответствует архитектуре, перескачиваем..."
        rm -f /opt/bin/ciadpi
    fi
fi

if [ "$NEED_DOWNLOAD" -eq 1 ]; then
    echo "  Скачиваем ByeDPI демон для архитектуры $DPI_ARCH..."
    BYEDPI_URL="https://github.com/hufrea/byedpi/releases/download/v0.17.3/byedpi-17.3-${DPI_ARCH}.tar.gz"
    curl -sSL "$BYEDPI_URL" | tar -xz -C /tmp/ 2>/dev/null
    
    if [ -f "/tmp/ciadpi-${DPI_ARCH}" ]; then
        mv -f "/tmp/ciadpi-${DPI_ARCH}" /opt/bin/ciadpi
    elif [ -f "/tmp/ciadpi" ]; then
        mv -f "/tmp/ciadpi" /opt/bin/ciadpi
    fi
    chmod +x /opt/bin/ciadpi 2>/dev/null
    
    # Проверяем запуск скачанного бинарника
    if /opt/bin/ciadpi -h >/dev/null 2>&1 || /opt/bin/ciadpi --help >/dev/null 2>&1; then
        echo "  ✓ ByeDPI ($DPI_ARCH) успешно установлен и проверен на запуск."
    else
        echo "  ⚠️ Ошибка проверки запуска $DPI_ARCH. Пробуем альтернативные варианты сборки..."
        if [ "$DPI_ARCH" = "mipsel" ]; then ALT_ARCH="mips"; elif [ "$DPI_ARCH" = "mips" ]; then ALT_ARCH="mipsel"; elif [ "$DPI_ARCH" = "aarch64" ]; then ALT_ARCH="armv7l"; else ALT_ARCH=""; fi
        if [ -n "$ALT_ARCH" ]; then
            echo "  Пробуем сборку $ALT_ARCH..."
            curl -sSL "https://github.com/hufrea/byedpi/releases/download/v0.17.3/byedpi-17.3-${ALT_ARCH}.tar.gz" | tar -xz -C /tmp/ 2>/dev/null
            if [ -f "/tmp/ciadpi-${ALT_ARCH}" ]; then
                mv -f "/tmp/ciadpi-${ALT_ARCH}" /opt/bin/ciadpi
            elif [ -f "/tmp/ciadpi" ]; then
                mv -f "/tmp/ciadpi" /opt/bin/ciadpi
            fi
            chmod +x /opt/bin/ciadpi 2>/dev/null
            if /opt/bin/ciadpi -h >/dev/null 2>&1 || /opt/bin/ciadpi --help >/dev/null 2>&1; then
                echo "  ✓ Альтернативная сборка ByeDPI ($ALT_ARCH) успешно запустилась!"
            fi
        fi
    fi
fi

# Создаем симлинки для независимого управления процессами
ln -sf /opt/bin/ciadpi /opt/bin/ciadpi-1
ln -sf /opt/bin/ciadpi /opt/bin/ciadpi-2

# Удаляем старую службу если была
rm -f /opt/etc/init.d/S52ciadpi-youtube 2>/dev/null

# 1. Служба S52ciadpi-1 (⚡ ByeDPI 1 — ТВ, порт 10805)
cat << 'EOF' > /opt/etc/init.d/S52ciadpi-1
#!/bin/sh

ENABLED=yes
PROCS=/opt/bin/ciadpi-1
PREARGS=""
ARGS="-i 127.0.0.1 -p 10805 --split 1+s --disorder 1+s -D --pidfile /opt/var/run/ciadpi-1.pid"
DESC="ciadpi-1 (ByeDPI 1 - TV)"
PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

. /opt/etc/init.d/rc.func
EOF
chmod +x /opt/etc/init.d/S52ciadpi-1
/opt/etc/init.d/S52ciadpi-1 restart 2>/dev/null

# 2. Служба S53ciadpi-2 (⚡ ByeDPI 2 — Смартфоны/ПК, порт 10806)
cat << 'EOF' > /opt/etc/init.d/S53ciadpi-2
#!/bin/sh

ENABLED=yes
PROCS=/opt/bin/ciadpi-2
PREARGS=""
ARGS="-i 127.0.0.1 -p 10806 --tlsrec 1 -D --pidfile /opt/var/run/ciadpi-2.pid"
DESC="ciadpi-2 (ByeDPI 2 - Phone/PC)"
PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

. /opt/etc/init.d/rc.func
EOF
chmod +x /opt/etc/init.d/S53ciadpi-2
/opt/etc/init.d/S53ciadpi-2 restart 2>/dev/null

echo "  ✓ Службы YouTube DPI-Bypass настроены и запущены (ByeDPI 1: 10805, ByeDPI 2: 10806)"

# 6. Развертывание базовой конфигурации config.yaml
echo "→ Шаг 5: Проверка и развертывание конфигурации Mihomo..."
mkdir -p /opt/etc/mihomo/proxy_providers
if [ ! -f "/opt/etc/mihomo/config.yaml" ]; then
    if [ -f "$INSTALL_DIR/config.yaml" ]; then
        cp "$INSTALL_DIR/config.yaml" /opt/etc/mihomo/config.yaml
        echo "  ✓ Развернут базовый config.yaml"
    elif [ -f "$INSTALL_DIR/config.example.yaml" ]; then
        cp "$INSTALL_DIR/config.example.yaml" /opt/etc/mihomo/config.yaml
        echo "  ✓ Развернут базовый config.yaml из шаблона config.example.yaml"
    fi
fi

# Перезапуск службы Mihomo (если установлена), чтобы подхватить конфиг
if [ -f "/opt/etc/init.d/S99mihomo" ]; then
    /opt/etc/init.d/S99mihomo restart 2>/dev/null
elif [ -f "/opt/etc/init.d/S99clash" ]; then
    /opt/etc/init.d/S99clash restart 2>/dev/null
fi

# 7. Создание/обновление службы автозапуска веб-панели
echo "→ Шаг 6: Настройка службы автозапуска веб-панели..."

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
if [ -f "$INSTALL_DIR/uninstall.sh" ]; then
    chmod +x "$INSTALL_DIR/uninstall.sh"
fi

# 8. Запуск веб-панели
echo "→ Шаг 7: Запуск Mihomo Controller..."
if [ -f "$INIT_SCRIPT" ]; then
    "$INIT_SCRIPT" restart
fi

# Определение локального IP-адреса роутера для вывода ссылки
ROUTER_IP=$(ip -4 addr show br0 2>/dev/null | grep -o 'inet [0-9.]*' | head -n1 | awk '{print $2}' || true)
if [ -z "$ROUTER_IP" ]; then
    ROUTER_IP=$(ip route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | head -n1 | awk '{print $2}' || true)
fi
if [ -z "$ROUTER_IP" ]; then
    ROUTER_IP="192.168.1.1"
fi

echo ""
echo "========================================="
if [ "$MODE" = "update" ]; then
    echo "  ✓ Обновление успешно завершено!"
else
    echo "  ✓ Установка успешно завершена!"
fi
echo ""
echo "  YouTube DPI-Bypass: Работает из коробки (порт 10805)"
echo "  Панель управления: http://${ROUTER_IP}:4000 (или http://127.0.0.1:4000)"
echo ""
if ! command -v mihomo >/dev/null 2>&1 && [ ! -f "/opt/bin/mihomo" ] && [ ! -f "/opt/etc/init.d/S99mihomo" ]; then
    echo "  💡 Примечание: Убедитесь, что ядро Mihomo (или XKeen) установлено на роутере."
fi
echo "  Для полного удаления панели запустите:"
echo "  sh -c \"\$(curl -fsSL https://raw.githubusercontent.com/$GITHUB_USER/$REPO_NAME/$BRANCH/uninstall.sh)\""
echo "========================================="
