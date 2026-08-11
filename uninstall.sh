#!/bin/sh

# ============================================
#   Mihomo Controller — Полное удаление
# ============================================

INSTALL_DIR="/opt/root/mihomo-controller"
INIT_SCRIPT="/opt/etc/init.d/S99mihomo-controller"

echo "========================================="
echo "   Удаление Mihomo Controller"
echo "========================================="

# 1. Остановка службы
if [ -f "$INIT_SCRIPT" ]; then
    echo "→ Останавливаем службу mihomo-controller..."
    "$INIT_SCRIPT" stop 2>/dev/null
    rm -f "$INIT_SCRIPT"
    echo "  ✓ Служба автозапуска удалена."
fi

# 2. Принудительное завершение фоновых процессов Node.js
echo "→ Завершаем фоновые процессы..."
pkill -f "server.js" 2>/dev/null
pkill -f "updater.js" 2>/dev/null

# 3. Удаление файлов проекта
if [ -d "$INSTALL_DIR" ]; then
    echo "→ Удаляем файлы из $INSTALL_DIR..."
    rm -rf "$INSTALL_DIR"
    echo "  ✓ Директория проекта удалена."
fi

echo ""
echo "========================================="
echo "  ✓ Mihomo Controller полностью удалён!"
echo "========================================="
echo ""
