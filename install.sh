#!/bin/sh

# Настройки репозитория (замените на ваш юзернейм после загрузки на GitHub)
GITHUB_USER="Niko0197"
REPO_NAME="mihomo-controller"
BRANCH="main"

INSTALL_DIR="/opt/root/mihomo-controller"
INIT_SCRIPT="/opt/etc/init.d/S99mihomo-controller"

echo "========================================="
echo "   Установка Mihomo Controller на Keenetic"
echo "========================================="

# 1. Проверка Entware
if [ ! -d "/opt" ]; then
    echo "Ошибка: Entware не обнаружен! Убедитесь, что Entware установлен на роутере."
    exit 1
fi

# 2. Обновление пакетов и установка зависимостей
echo "Шаг 1: Проверка и установка зависимостей (Node.js, curl, tar)..."
opkg update

if ! command -v node >/dev/null 2>&1; then
    echo "Устанавливаем Node.js..."
    opkg install node
fi

if ! command -v curl >/dev/null 2>&1; then
    echo "Устанавливаем curl..."
    opkg install curl
fi

if ! command -v tar >/dev/null 2>&1; then
    echo "Устанавливаем tar..."
    opkg install tar
fi

# 3. Скачивание исходников
echo "Шаг 2: Скачивание Mihomo Controller..."
mkdir -p /opt/root

# Скачиваем архив ветки main и распаковываем
TEMP_TAR="/tmp/mihomo-controller.tar.gz"
curl -sL "https://github.com/$GITHUB_USER/$REPO_NAME/archive/refs/heads/$BRANCH.tar.gz" -o "$TEMP_TAR"

if [ ! -f "$TEMP_TAR" ]; then
    echo "Ошибка: Не удалось скачать файлы с GitHub. Проверьте имя пользователя и репозиторий."
    exit 1
fi

# Очищаем старую версию если есть
rm -rf "$INSTALL_DIR"
rm -rf "/opt/root/$REPO_NAME-$BRANCH"

# Распаковываем
tar -xzf "$TEMP_TAR" -C /opt/root/
mv "/opt/root/$REPO_NAME-$BRANCH" "$INSTALL_DIR"
rm -f "$TEMP_TAR"

echo "Файлы успешно скопированы в $INSTALL_DIR"

# 4. Создание службы автозапуска в Entware
echo "Шаг 3: Настройка службы автозапуска..."

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
echo "Служба автозапуска создана: $INIT_SCRIPT"

# 5. Запуск веб-панели
echo "Шаг 4: Запуск Mihomo Controller..."
if [ -f "$INIT_SCRIPT" ]; then
    "$INIT_SCRIPT" restart
fi

echo "========================================="
echo "Установка успешно завершена!"
echo "Панель управления доступна по адресу:"
echo "http://192.168.1.1:4000"
echo "========================================="
