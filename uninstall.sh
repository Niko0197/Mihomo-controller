#!/bin/sh

# ============================================
#   Mihomo Controller — Полное удаление
# ============================================

echo "========================================="
echo "   Удаление Mihomo Controller с Keenetic"
echo "========================================="

# 1. Проверка прав/директории Entware
if [ ! -d "/opt" ]; then
    echo "✗ Ошибка: Среда Entware (/opt) не найдена."
    exit 1
fi

# 2. Остановка и удаление служб автозапуска
echo "→ Шаг 1: Остановка и удаление службы автозапуска..."

# Проверяем возможные имена скриптов инициализации
for SERVICE in S99mihomo-controller S99vpn-updater-web; do
    INIT_SCRIPT="/opt/etc/init.d/$SERVICE"
    if [ -f "$INIT_SCRIPT" ]; then
        echo "  Останавливаем службу $SERVICE..."
        "$INIT_SCRIPT" stop 2>/dev/null
        sleep 1
        echo "  Удаляем службу $SERVICE..."
        rm -f "$INIT_SCRIPT"
    fi
done

# 3. Удаление файлов приложения
echo "→ Шаг 2: Удаление файлов приложения..."

# Проверяем возможные пути установки
for DIR in /opt/root/mihomo-controller /opt/root/vpn_updater; do
    if [ -d "$DIR" ]; then
        echo "  Удаляем директорию $DIR..."
        rm -rf "$DIR"
    fi
done

# 4. Предложение удалить файлы конфигурации Mihomo (опционально)
echo "→ Шаг 3: Очистка конфигурации Mihomo..."
echo "ПРИМЕЧАНИЕ: Сама служба Mihomo и её файлы в /opt/etc/mihomo не были затронуты."
echo "Если вы хотите полностью удалить конфигурацию Mihomo (прокси, правила, бэкапы),"
echo "вы можете сделать это вручную, выполнив команду:"
echo "  rm -rf /opt/etc/mihomo"

echo ""
echo "========================================="
echo "  ✓ Mihomo Controller успешно удален!"
echo "========================================="
