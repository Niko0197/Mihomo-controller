#!/bin/sh

# ============================================
#   Mihomo Controller — Полное удаление
# ============================================

INSTALL_DIR="/opt/root/mihomo-controller"
INIT_SCRIPT="/opt/etc/init.d/S99mihomo-controller"
DPI_INIT="/opt/etc/init.d/S52ciadpi-youtube"

echo "========================================="
echo "   Удаление Mihomo Controller"
echo "========================================="

# 1. Остановка службы веб-панели
if [ -f "$INIT_SCRIPT" ]; then
    echo "→ Останавливаем службу mihomo-controller..."
    "$INIT_SCRIPT" stop 2>/dev/null
    rm -f "$INIT_SCRIPT"
    echo "  ✓ Служба автозапуска веб-панели удалена."
fi

# 2. Остановка служб YouTube DPI-Bypass
for SVC in /opt/etc/init.d/S52ciadpi-1 /opt/etc/init.d/S53ciadpi-2 /opt/etc/init.d/S52ciadpi-youtube; do
    if [ -f "$SVC" ]; then
        "$SVC" stop 2>/dev/null
        rm -f "$SVC"
    fi
done
rm -f /opt/bin/ciadpi /opt/bin/ciadpi-1 /opt/bin/ciadpi-2
echo "  ✓ Службы YouTube DPI-Bypass удалены."

# 3. Принудительное завершение фоновых процессов
echo "→ Завершаем фоновые процессы..."
pkill -f "server.js" 2>/dev/null
pkill -f "updater.js" 2>/dev/null
killall ciadpi ciadpi-1 ciadpi-2 2>/dev/null

# 4. Удаление файлов проекта
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
