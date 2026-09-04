/**
 * panel_logger.js
 * Подсистема постоянного логирования веб-панели Mihomo Controller
 * 
 * Особенности:
 * - Запись в файл logs/panel.log на диске роутера
 * - Ротация файла при достижении 2 МБ (panel.log -> panel.log.old)
 * - Кольцевой буфер в оперативной памяти (до 1500 записей) для быстрого API
 * - Перехват console.log, console.info, console.warn, console.error
 * - Безопасное форматирование аргументов без падений
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const MAX_MEMORY_LINES = 1500;

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'panel.log');
const OLD_LOG_FILE = path.join(LOG_DIR, 'panel.log.old');

let memoryLogs = [];
let isInitialized = false;

// Сохраняем оригинальные методы console
const origConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug ? console.debug.bind(console) : console.log.bind(console)
};

// Функция форматирования времени YYYY-MM-DD HH:mm:ss
function formatTimestamp(d = new Date()) {
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Очистка от ANSI escape-последовательностей для чистого текстового файла
function stripAnsi(str) {
  if (typeof str !== 'string') return String(str);
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

// Проверка и ротация файла лога
function checkRotation() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size >= MAX_FILE_SIZE) {
        if (fs.existsSync(OLD_LOG_FILE)) {
          try { fs.unlinkSync(OLD_LOG_FILE); } catch (e) {}
        }
        fs.renameSync(LOG_FILE, OLD_LOG_FILE);
        const rotateNotice = `[${formatTimestamp()}] [INFO] [LogRotation] Размер лога превысил 2 МБ. Предыдущий лог сохранён в panel.log.old\n`;
        fs.writeFileSync(LOG_FILE, rotateNotice, 'utf8');
      }
    }
  } catch (e) {
    origConsole.error('[panel_logger] Ошибка ротации лога:', e.message);
  }
}

// Запись строки в файл
function appendToFile(line) {
  try {
    checkRotation();
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    // В случае ошибки записи на диск не валим процесс
    origConsole.error('[panel_logger] Ошибка записи в panel.log:', e.message);
  }
}

// Добавление записи лога
function logEntry(level, args) {
  const timeStr = formatTimestamp();
  let rawMsg = '';
  try {
    rawMsg = util.format.apply(util, args);
  } catch (e) {
    rawMsg = args.join(' ');
  }

  const cleanMsg = stripAnsi(rawMsg);
  const formattedLine = `[${timeStr}] [${level.toUpperCase()}] ${cleanMsg}`;

  // 1. Сохраняем в кольцевой буфер ОЗУ
  const entry = {
    time: timeStr,
    level: level.toLowerCase(),
    message: cleanMsg
  };
  memoryLogs.push(entry);
  if (memoryLogs.length > MAX_MEMORY_LINES) {
    memoryLogs.shift();
  }

  // 2. Записываем в файл на диске
  appendToFile(formattedLine);
}

// Попытка создания симлинка в /opt/var/log для системных утилит Entware
function tryCreateEntwareSymlink() {
  try {
    if (process.platform === 'linux') {
      const entwareLogDir = '/opt/var/log';
      const symlinkPath = path.join(entwareLogDir, 'mihomo-controller.log');
      if (fs.existsSync(entwareLogDir) && !fs.existsSync(symlinkPath)) {
        fs.symlinkSync(LOG_FILE, symlinkPath);
      }
    }
  } catch (e) {}
}

// Загрузка последних строк из существующего файла логов при старте
function loadExistingLogsIntoMemory() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      const tailLines = lines.slice(-MAX_MEMORY_LINES);
      tailLines.forEach(line => {
        const match = line.match(/^\[([\d\- :]+)\]\s+\[([A-Z]+)\]\s+(.*)$/);
        if (match) {
          memoryLogs.push({
            time: match[1],
            level: match[2].toLowerCase(),
            message: match[3]
          });
        } else {
          memoryLogs.push({
            time: formatTimestamp(),
            level: 'info',
            message: line
          });
        }
      });
      if (memoryLogs.length > MAX_MEMORY_LINES) {
        memoryLogs = memoryLogs.slice(-MAX_MEMORY_LINES);
      }
    }
  } catch (e) {
    origConsole.error('[panel_logger] Не удалось загрузить историю логов:', e.message);
  }
}

// Инициализация перехвата консоли
function initLogger() {
  if (isInitialized) return;
  isInitialized = true;

  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch (e) {
    origConsole.error('[panel_logger] Не удалось создать папку logs:', e.message);
  }

  loadExistingLogsIntoMemory();
  tryCreateEntwareSymlink();

  // Перехватываем стандартные потоки console
  console.log = function(...args) {
    origConsole.log(...args);
    logEntry('info', args);
  };

  console.info = function(...args) {
    origConsole.info(...args);
    logEntry('info', args);
  };

  console.warn = function(...args) {
    origConsole.warn(...args);
    logEntry('warn', args);
  };

  console.error = function(...args) {
    origConsole.error(...args);
    logEntry('error', args);
  };

  if (console.debug) {
    console.debug = function(...args) {
      origConsole.debug(...args);
      logEntry('debug', args);
    };
  }

  // Стартовая отметка
  console.log(`[panel_logger] Подсистема логирования панели инициализирована. Файл: ${LOG_FILE}`);
}

// Получение отфильтрованных логов
function getRecentLogs(options = {}) {
  const tail = Math.min(Math.max(parseInt(options.tail, 10) || 500, 1), MAX_MEMORY_LINES);
  const targetLevel = (options.level || 'all').toLowerCase();
  const search = (options.search || '').toLowerCase().trim();

  let filtered = memoryLogs;

  if (targetLevel !== 'all') {
    filtered = filtered.filter(item => item.level === targetLevel);
  }

  if (search) {
    filtered = filtered.filter(item => 
      item.message.toLowerCase().includes(search) || 
      item.time.toLowerCase().includes(search)
    );
  }

  return filtered.slice(-tail);
}

// Очистка логов
function clearLogs() {
  memoryLogs = [];
  try {
    const clearNotice = `[${formatTimestamp()}] [INFO] Журнал веб-панели очищен пользователем через интерфейс.\n`;
    fs.writeFileSync(LOG_FILE, clearNotice, 'utf8');
    memoryLogs.push({
      time: formatTimestamp(),
      level: 'info',
      message: 'Журнал веб-панели очищен пользователем через интерфейс.'
    });
    return { success: true };
  } catch (e) {
    origConsole.error('[panel_logger] Ошибка очистки лога:', e.message);
    return { success: false, error: e.message };
  }
}

// Получение метаданных о логе
function getLogStats() {
  let size = 0;
  try {
    if (fs.existsSync(LOG_FILE)) {
      size = fs.statSync(LOG_FILE).size;
    }
  } catch (e) {}

  // Путь для SMB и Linux
  const linuxPath = '/opt/root/vpn_updater/logs/panel.log';
  const smbPath = '\\\\Netcraze-9884\\opkg\\root\\vpn_updater\\logs\\panel.log';

  return {
    filePath: LOG_FILE,
    linuxPath,
    smbPath,
    sizeBytes: size,
    sizeFormatted: (size / 1024).toFixed(1) + ' KB',
    totalBufferedLines: memoryLogs.length
  };
}

module.exports = {
  initLogger,
  getRecentLogs,
  clearLogs,
  getLogStats,
  LOG_FILE,
  LOG_DIR
};
