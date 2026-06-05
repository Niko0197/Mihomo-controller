const http = require('http');
const fs = require('fs');
const path = require('path');

const API_HOST = '192.168.1.1';
const API_PORT = 9090;
const DEBOUNCE_MS = 10000; // 10 секунд буфер перед применением правил
const TTL_MONTHS = 6;
const DB_PATH = path.join(__dirname, 'smart_unblock_db.json');
const RULES_YAML_PATH = '/opt/etc/mihomo/smart_unblock.yaml';
const PID_PATH = path.join(__dirname, 'smart_router.pid');

console.log('========================================================');
console.log(' [Smart Router] Фоновый демон самообучения успешно запущен');
console.log('========================================================');

// Сохраняем свой PID для мониторинга со стороны updater.js
fs.writeFileSync(PID_PATH, process.pid.toString(), 'utf8');

let queue = new Set();
let debounceTimeout = null;
let db = {};

// Инициализация пустой базы данных при необходимости
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify({}, null, 2), 'utf8');
}

// Загрузка существующей базы данных
try {
  db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  console.log(`[Smart Router] Загружена база данных. Всего правил: ${Object.keys(db).length}`);
} catch (e) {
  console.error('[Smart Router] Ошибка разбора smart_unblock_db.json, сброс', e);
  db = {};
}

// Список гарантированно безопасных российских / локальных доменов для белого списка
const whitelist = new Set([
  'gosuslugi.ru', 'sberbank.ru', 'sber.ru', 'tinkoff.ru', 'tbank.ru',
  'avito.ru', 'wildberries.ru', 'ozon.ru', 'rutube.ru', 'vk.com', 'mail.ru',
  'yandex.ru', 'yastatic.net', 'local', 'lan', 'keenetic.link', 'keenetic.pro',
  'keenetic.net', '2ip.ru', 'ident.me', 'ifconfig.me', 'ifconfig.co', 'ipify.org'
]);

function isWhitelisted(domain) {
  if (!domain) return true;
  if (whitelist.has(domain)) return true;
  
  for (const item of whitelist) {
    if (domain.endsWith('.' + item)) return true;
  }
  return false;
}

// Легковесный выделитель базового зарегистрированного домена (SLD + TLD)
function getBaseDomain(host) {
  if (!host) return null;
  host = host.toLowerCase().trim();
  
  // Убираем порт, если он есть
  host = host.split(':')[0];
  
  // Игнорируем чистые IP-адреса IPv4 и IPv6
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':') || host.includes('[') || host.includes(']')) {
    return null;
  }

  // Общеизвестные multipart TLD (двухсегментные окончания)
  const multiPartTlds = new Set([
    'com.ru', 'net.ru', 'org.ru', 'pp.ru', 'msk.ru', 'spb.ru', 'nov.ru', 'sochi.ru',
    'co.uk', 'me.uk', 'org.uk', 'ltd.uk', 'plc.uk',
    'com.ua', 'net.ua', 'org.ua', 'edu.ua', 'gov.ua',
    'com.by', 'gov.by',
    'com.kz', 'org.kz',
    'com.tr', 'edu.tr',
    'com.br', 'net.br',
    'com.cn', 'net.cn', 'org.cn',
    'com.au', 'net.au', 'org.au'
  ]);

  const parts = host.split('.');
  if (parts.length <= 2) {
    return host;
  }

  const lastTwo = parts.slice(-2).join('.');
  if (multiPartTlds.has(lastTwo)) {
    return parts.slice(-3).join('.');
  } else {
    return parts.slice(-2).join('.');
  }
}

// Парсер логов: извлекает домен только в случае сбоев соединения по DIRECT
function extractDomainFromLog(payload) {
  // Паттерн 1: Стандартная запись об ошибке подключения по DIRECT
  const dialMatch = payload.match(/\[(?:TCP|UDP)\] dial DIRECT ([^\s:]+)(:\d+)? (?:failed|error):\s*(.*)/i);
  if (dialMatch) {
    return getBaseDomain(dialMatch[1]);
  }
  
  // Паттерн 2: Общие ключевые слова сбоев для DIRECT в логах уровня debug
  if (payload.includes('dial DIRECT')) {
    const genericMatch = payload.match(/dial DIRECT ([^\s:]+)/i);
    if (genericMatch) {
      const lower = payload.toLowerCase();
      if (lower.includes('failed') || lower.includes('error') || lower.includes('timeout') || lower.includes('reset')) {
        return getBaseDomain(genericMatch[1]);
      }
    }
  }
  return null;
}

// Функция отправки реального HTTPS GET-запроса через прокси-группу Mihomo
async function checkUrlAccessibility(proxyName, url, timeoutMs) {
  return new Promise((resolve) => {
    const encodedUrl = encodeURIComponent(url);
    const apiPath = `/proxies/${encodeURIComponent(proxyName)}/delay?url=${encodedUrl}&timeout=${timeoutMs}`;
    
    const req = http.request({
      hostname: API_HOST,
      port: API_PORT,
      path: apiPath,
      method: 'GET',
      timeout: timeoutMs + 500
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed.delay === 'number' && parsed.delay > 0) {
              resolve(true); // Соединение успешно прошло
              return;
            }
          } catch (e) {}
        }
        resolve(false); // Сбой или таймаут
      });
    });
    
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// Двухфакторная проверка блокировки (с полным HTTPS TLS GET тестом против ТСПУ)
async function verifyBlocking(domain) {
  const url = `https://${domain}`;
  
  // 1. Проверяем напрямую: ожидаем сбой (таймаут или сброс соединения)
  const isDirectAccessible = await checkUrlAccessibility('DIRECT', url, 2000);
  if (isDirectAccessible) {
    return false; // Доступен напрямую, блокировки нет!
  }
  
  // 2. Проверяем через VPN: ожидаем успешный ответ
  const isVpnAccessible = await checkUrlAccessibility('🚀Auto-Best', url, 3000);
  if (isVpnAccessible) {
    return true; // DIRECT лежит, VPN работает -> Доказанная блокировка DPI
  }
  
  return false; // Лежит везде (проблема сайта или интернета в целом)
}

// Запись в YAML-файл провайдера правил smart_unblock.yaml
function updateRulesYaml() {
  try {
    const activeDomains = Object.keys(db).filter(d => db[d].status === 'blocked');
    
    const yamlLines = ['payload:'];
    activeDomains.forEach(domain => {
      yamlLines.push(`  - DOMAIN-SUFFIX,${domain}`);
    });
    
    fs.writeFileSync(RULES_YAML_PATH, yamlLines.join('\n') + '\n', 'utf8');
    console.log(`[Smart Router] Обновлен smart_unblock.yaml. Активных правил: ${activeDomains.length}`);
  } catch (err) {
    console.error('[Smart Router] Ошибка записи smart_unblock.yaml:', err.message);
  }
}

// Горячий релоад rule-provider в памяти Mihomo без перезагрузки ядра
function reloadMihomoProvider() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: API_HOST,
      port: API_PORT,
      path: '/providers/rules/smart_unblock',
      method: 'PUT',
      timeout: 3000
    }, (res) => {
      console.log(`[Smart Router] Rule-provider hot-reloaded: HTTP ${res.statusCode}`);
      resolve(res.statusCode === 204);
    });
    
    req.on('error', (err) => {
      console.error('[Smart Router] Ошибка вызова горячей перезагрузки:', err.message);
      resolve(false);
    });
    req.end();
  });
}

// Обработка очереди кандидатов по истечении debounce таймера
function processQueue() {
  if (queue.size === 0) return;
  
  const candidates = Array.from(queue);
  queue.clear();
  
  console.log(`[Smart Router] Обработка очереди кандидатов (${candidates.length} шт)...`);
  
  (async () => {
    let changed = false;
    for (const domain of candidates) {
      if (db[domain] && db[domain].status === 'blocked') continue;
      
      console.log(`[Smart Router] Валидация блокировки для домена: ${domain}`);
      const isBlocked = await verifyBlocking(domain);
      
      if (isBlocked) {
        console.log(`[Smart Router] БЛОКИРОВКА ПОДТВЕРЖДЕНА: ${domain} добавлен в VPN!`);
        db[domain] = {
          addedAt: new Date().toISOString(),
          lastVerified: new Date().toISOString(),
          status: 'blocked'
        };
        changed = true;
      } else {
        console.log(`[Smart Router] Домен ${domain} доступен напрямую или лежит на VPN. Пропущен.`);
      }
    }
    
    if (changed) {
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
      updateRulesYaml();
      await reloadMihomoProvider();
    }
  })();
}

function addToQueue(domain) {
  if (!domain || isWhitelisted(domain)) return;
  if (db[domain] && db[domain].status === 'blocked') return;
  
  queue.add(domain);
  
  if (debounceTimeout) {
    clearTimeout(debounceTimeout);
  }
  
  debounceTimeout = setTimeout(processQueue, DEBOUNCE_MS);
}

// Автоматический сборщик логов Mihomo (Connection Stream)
function startLogStream() {
  console.log('[Smart Router] Подключение к API стриминга логов Mihomo...');
  
  const req = http.request({
    hostname: API_HOST,
    port: API_PORT,
    path: '/logs?level=debug',
    method: 'GET',
    timeout: 0 // Стрим держится постоянно
  }, (res) => {
    console.log(`[Smart Router] Поток логов подключен (HTTP ${res.statusCode})`);
    
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      
      // Последнюю неполную строку оставляем в буфере
      buffer = lines.pop();
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        try {
          const logEvent = JSON.parse(trimmed);
          if (logEvent && logEvent.payload) {
            const domain = extractDomainFromLog(logEvent.payload);
            if (domain) {
              addToQueue(domain);
            }
          }
        } catch (e) {
          // Игнорируем битые строки JSON
        }
      }
    });
    
    res.on('end', () => {
      console.log('[Smart Router] Стрим логов разорван сервером. Переподключение через 5 секунд...');
      setTimeout(startLogStream, 5000);
    });
    
    res.on('error', (err) => {
      console.error('[Smart Router] Сбой в стриме логов:', err.message);
    });
  });
  
  req.on('error', (err) => {
    console.error('[Smart Router] Ошибка подключения к API логов. Переподключение через 10 секунд...', err.message);
    setTimeout(startLogStream, 10000);
  });
  
  req.end();
}

// Ночная очистка и перепроверка правил (TTL 6 месяцев)
async function checkExpiredRules() {
  console.log('[Smart Router] Запуск плановой проверки TTL правил...');
  const now = new Date();
  let changed = false;
  
  for (const domain of Object.keys(db)) {
    if (db[domain].status === 'blocked') {
      const addedDate = new Date(db[domain].addedAt || db[domain].lastVerified);
      const diffMs = now - addedDate;
      const diffMonths = diffMs / (1000 * 60 * 60 * 24 * 30.4);
      
      if (diffMonths >= TTL_MONTHS) {
        console.log(`[Smart Router] Домен ${domain} старше ${TTL_MONTHS} месяцев. Перепроверяем блокировку...`);
        
        const stillBlocked = await verifyBlocking(domain);
        if (!stillBlocked) {
          console.log(`[Smart Router] Домен ${domain} разблокирован напрямую! Удаляем из VPN-правил.`);
          delete db[domain];
          changed = true;
        } else {
          console.log(`[Smart Router] Домен ${domain} всё еще заблокирован. Продлеваем TTL на 6 месяцев.`);
          db[domain].lastVerified = now.toISOString();
        }
      }
    }
  }
  
  if (changed) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    updateRulesYaml();
    await reloadMihomoProvider();
  }
  console.log('[Smart Router] Проверка TTL правил успешно завершена.');
}

// Запускаем ежедневный мониторинг TTL правил (раз в 24 часа)
setInterval(checkExpiredRules, 24 * 60 * 60 * 1000);

// Первоначальный старт
startLogStream();
