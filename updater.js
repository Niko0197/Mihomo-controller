const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_PORT = 9090;
const API_HOST = '192.168.1.1';
const logRuPath = path.join(__dirname, 'log_ru.txt');

// Вспомогательная функция для получения текущего времени в удобном формате
function getTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Универсальный клиент для выполнения HTTP-запросов к API Mihomo
function makeRequest(method, endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path: endpoint,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 10000 // 10 секунд таймаут
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          data: data
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Превышено время ожидания ответа от API'));
    });

    req.end();
  });
}

// Проверка соответствия домена ключевым словам (должны ходить напрямую)
function isRussianDomain(host) {
  if (!host) return false;
  host = host.toLowerCase();

  // Общие российские TLD
  if (host.endsWith('.ru') || host.includes('.ru.') || 
      host.endsWith('.su') || host.includes('.su.') || 
      host.endsWith('.xn--p1ai') || // .рф
      host.endsWith('.xn--p1acf') || // .рус
      host.endsWith('.xn--80asehdb') || // .онлайн
      host.endsWith('.xn--c1avg') || // .орг
      host.endsWith('.xn--80aswg') || // .сайт
      host.endsWith('.xn--80adxhks') || // .москва
      host.endsWith('.moscow')) {
    return true;
  }

  // Конкретный список ключевых слов от пользователя
  const keywords = [
    'vk.com', 'vk.me', 'vk-portal', 'vkuserlogic', 'vk-cdn', 'vkontakte',
    'yandex', 'yadns', 'yastatic', 'yamoney', 'kinopoisk',
    'mail.ru', 'my.com', 'mail.ru.com',
    'rambler',
    'gosuslugi',
    'sberbank', 'sber',
    'tinkoff', 'tbank',
    'avito',
    'wildberries', 'wb',
    'ozon',
    'dzen',
    'rutube',
    'odnoklassniki', 'ok.ru',
    'max',
    // --- ВАШИ КЛЮЧЕВЫЕ СЛОВА ---
    'iknpd', 'lknpd', 'nalog', 'hrtek', 'vk',
    // --- ДОПОЛНИТЕЛЬНЫЕ ЭКОСИСТЕМНЫЕ ДОМЕНЫ (VK, YANDEX, OZON) ---
    'ok.me', 'okcdn', 'tamtam', 'rustore', 'mygames', 'my.games', 'icq', 'marusya', 'marusia', // VK Group
    'ya.ru', 'yadi.sk', 'edadeal', // Yandex
    // --- РЕКОМЕНДОВАННЫЕ РУ-СЕРВИСЫ ---
    'mos', 'sfr', 'pfr', 'fss', 'zakupki', 'gibdd',
    'alfa', 'alfabank', 'vtb', 'raiffeisen', 'gazprombank', 'gpb', 'rshb', 'rosbank', 'qiwi', 'yoomoney', 'cbr',
    'mts', 'megafon', 'beeline', 'tele2', 't2', 'rostelecom', 'rt.ru', 'yota',
    'habr', '1c', 'bitrix', 'smotrim', '1tv', 'vgtrk', 'tass', 'ria', 'rian', 'rbc', 'lenta', 'kommersant', 'vedomosti',
    'cian', 'domclick', 'kuper', 'samokat', 'delivery-club', 'delivery', 'cdek', 'boxberry', 'lamoda',
    'nspk', 'mirpay', 'privetmir', 'sbp',
    // --- РОССИЙСКИЕ БУКМЕКЕРЫ ---
    '1win', 'betboom', 'winline', 'fonbet', 'ligastavok', 'paribet', 'melbet', 'leon', 'tennisi', 'olimpbet', 'marathonbet', 'zenitbet', '1xstavka', '1xbet'
  ];

  return keywords.some(keyword => {
    if (keyword === 'max' || keyword === 'okcdn' || keyword === 'vk') {
      // Ищем как отдельный сегмент поддомена, чтобы избежать ложных срабатываний (например, tiktokcdn.com)
      return host === keyword || host.startsWith(keyword + '.') || host.includes('.' + keyword + '.') || host.endsWith('.' + keyword);
    }
    return host.includes(keyword);
  });
}

function downloadHttpsFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP статус ${res.statusCode} для ${url}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function updateTorBridges(force = false) {
  const torJsonPath = path.join(__dirname, 'tor_bridges.json');
  
  if (!force && fs.existsSync(torJsonPath)) {
    try {
      const stats = fs.statSync(torJsonPath);
      const mtime = stats.mtime;
      const diffHrs = (new Date() - mtime) / (1000 * 60 * 60);
      if (diffHrs < 8) {
        // Пропускаем обновление, если прошло меньше 8 часов
        return;
      }
    } catch (e) {}
  }
  
  console.log(`[${getTimestamp()}] Запуск фонового обновления Tor мостов с GitHub...`);
  
  const files = {
    obfs4: 'https://raw.githubusercontent.com/Delta-Kronecker/Tor-Bridges-Collector/main/bridge/obfs4.txt',
    obfs4_tested: 'https://raw.githubusercontent.com/Delta-Kronecker/Tor-Bridges-Collector/main/bridge/obfs4_tested.txt',
    webtunnel: 'https://raw.githubusercontent.com/Delta-Kronecker/Tor-Bridges-Collector/main/bridge/webtunnel.txt',
    webtunnel_tested: 'https://raw.githubusercontent.com/Delta-Kronecker/Tor-Bridges-Collector/main/bridge/webtunnel_tested.txt',
    vanilla: 'https://raw.githubusercontent.com/Delta-Kronecker/Tor-Bridges-Collector/main/bridge/vanilla.txt',
    vanilla_tested: 'https://raw.githubusercontent.com/Delta-Kronecker/Tor-Bridges-Collector/main/bridge/vanilla_tested.txt'
  };
  
  const result = {
    lastUpdated: new Date().toISOString(),
    bridges: {}
  };
  
  for (const [key, url] of Object.entries(files)) {
    try {
      const content = await downloadHttpsFile(url);
      result.bridges[key] = content;
    } catch (err) {
      console.error(`[${getTimestamp()}] Ошибка скачивания мостов ${key}: ${err.message}`);
      if (fs.existsSync(torJsonPath)) {
        try {
          const oldData = JSON.parse(fs.readFileSync(torJsonPath, 'utf8'));
          if (oldData.bridges && oldData.bridges[key]) {
            result.bridges[key] = oldData.bridges[key];
          } else {
            result.bridges[key] = '';
          }
        } catch (e) {
          result.bridges[key] = '';
        }
      } else {
        result.bridges[key] = '';
      }
    }
  }
  
  try {
    fs.writeFileSync(torJsonPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(`[${getTimestamp()}] Tor мосты сохранены в tor_bridges.json`);
  } catch (err) {
    console.error(`[${getTimestamp()}] Ошибка записи tor_bridges.json: ${err.message}`);
  }
}

async function main() {
  // Временное убийство старого процесса server.js
  /*
  if (process.platform !== 'win32') {
    try {
      const execSync = require('child_process').execSync;
      const psOutput = execSync('ps -w').toString('utf8');
      const lines = psOutput.split('\n');
      
      lines.forEach(line => {
        if (line.includes('server.js') && !line.includes('updater.js')) {
          const trimmed = line.trim();
          const parts = trimmed.split(/\s+/);
          const pid = parseInt(parts[0], 10);
          if (pid && pid !== process.pid) {
            try {
              process.kill(pid, 9);
            } catch (err) {
              execSync(`kill -9 ${pid} || true`);
            }
          }
        }
      });
    } catch (e) {}
  }
  */

  const updateResults = [];

  // 1. Динамически получаем все провайдеры прокси из API Mihomo
  try {
    const res = await makeRequest('GET', '/providers/proxies');
    if (res.statusCode === 200) {
      const connData = JSON.parse(res.data);
      const providers = connData.providers || {};
      
      // Фильтруем именно провайдеры подписок (у которых vehicleType равен 'HTTP')
      const proxyProviderNames = Object.keys(providers).filter(key => {
        const p = providers[key];
        return p && (p.vehicleType === 'HTTP' || p.vehicleType === 'http');
      });

      // Обновляем каждый найденный провайдер прокси
      for (const name of proxyProviderNames) {
        try {
          const updateRes = await makeRequest('PUT', `/providers/proxies/${encodeURIComponent(name)}`);
          const status = updateRes.statusCode === 204 ? 'Успешно (204)' : `Ошибка (${updateRes.statusCode})`;
          updateResults.push(`${name}: ${status}`);
        } catch (err) {
          updateResults.push(`${name}: Ошибка (${err.message})`);
        }
      }
    } else {
      updateResults.push(`Ошибка получения списка провайдеров: HTTP статус ${res.statusCode}`);
    }
  } catch (err) {
    updateResults.push(`Ошибка подключения к API для получения провайдеров: ${err.message}`);
  }

  // Пишем результат обновления подписок в stdout (который cron перенаправит в log.txt)
  if (updateResults.length > 0) {
    console.log(`[${getTimestamp()}] Обновление подписок: ${updateResults.join(', ')}`);
  }

  // 3. Сканируем активные соединения на предмет утечки российских доменов через VPN
  try {
    const res = await makeRequest('GET', '/connections');
    if (res.statusCode === 200) {
      const connData = JSON.parse(res.data);
      const connections = connData.connections || [];

      if (connections.length > 0) {
        // Читаем уже залогированные домены, чтобы не спамить дубликатами
        let existingLogs = '';
        if (fs.existsSync(logRuPath)) {
          existingLogs = fs.readFileSync(logRuPath, 'utf8');
        }

        for (const conn of connections) {
          const host = conn.metadata ? conn.metadata.host : '';
          const chains = conn.chains || [];
          const rule = conn.rule || '';

          if (host && chains.length > 0) {
            const mainChain = chains[0];
            
            // Если трафик пошел через прокси-группу (а не DIRECT или REJECT)
            if (mainChain !== 'DIRECT' && mainChain !== 'REJECT') {
              if (isRussianDomain(host)) {
                // Если этого домена еще нет в логе, записываем
                if (!existingLogs.includes(host)) {
                  const chainStr = chains.join(' -> ');
                  const logLine = `[${getTimestamp()}] ВНИМАНИЕ: Домен ${host} пошел через VPN! Цепочка: ${chainStr} | Правило: ${rule}\n`;
                  fs.appendFileSync(logRuPath, logLine, 'utf8');
                  existingLogs += host + '\n'; // Обновляем локально, чтобы не писать повторно за этот же цикл
                }
              }
            }
          }
        }
      }
    }
  } catch (err) {
    // Ошибки при сканировании соединений пишем в stderr/stdout
    console.error(`[${getTimestamp()}] Ошибка при сканировании соединений: ${err.message}`);
  }

  // Обновляем список Tor мостов в фоне
  try {
    await updateTorBridges();
  } catch (err) {
    console.error(`[${getTimestamp()}] Ошибка фонового обновления Tor мостов: ${err.message}`);
  }

  // Проверяем работу веб-сервера и при необходимости запускаем его в фоне
  ensureServerRunning();
  ensureSmartRouterRunning();
}

function ensureServerRunning() {
  const options = {
    hostname: API_HOST,
    port: 4000,
    path: '/api/data',
    method: 'GET',
    timeout: 2000
  };

  const req = http.request(options, (res) => {
    // Сервер отвечает, всё отлично!
  });

  req.on('error', (err) => {
    // Сервер не отвечает (остановлен), запускаем в фоновом режиме
    const logMsg = `[${getTimestamp()}] Веб-сервер на порту 4000 остановлен. Автозапуск в фоне...\n`;
    fs.appendFileSync(path.join(__dirname, 'log.txt'), logMsg, 'utf8');

    const spawn = require('child_process').spawn;
    const out = fs.openSync(path.join(__dirname, 'server_out.log'), 'a');
    const errFile = fs.openSync(path.join(__dirname, 'server_err.log'), 'a');

    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      detached: true,
      stdio: ['ignore', out, errFile]
    });

    child.unref();
  });

  req.on('timeout', () => {
    req.destroy();
  });

  req.end();
}

function ensureSmartRouterRunning() {
  const pidPath = path.join(__dirname, 'smart_router.pid');
  let isRunning = false;
  
  if (fs.existsSync(pidPath)) {
    try {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
      if (pid) {
        process.kill(pid, 0); // Проверяем, существует ли процесс
        isRunning = true;
      }
    } catch (err) {
      isRunning = false;
    }
  }
  
  if (!isRunning) {
    const logMsg = `[${getTimestamp()}] Фоновый демон smart_router.js остановлен. Автозапуск в фоне...\n`;
    fs.appendFileSync(path.join(__dirname, 'log.txt'), logMsg, 'utf8');
    
    const spawn = require('child_process').spawn;
    const out = fs.openSync(path.join(__dirname, 'smart_router_out.log'), 'a');
    const errFile = fs.openSync(path.join(__dirname, 'smart_router_err.log'), 'a');
    
    const child = spawn(process.execPath, [path.join(__dirname, 'smart_router.js')], {
      detached: true,
      stdio: ['ignore', out, errFile]
    });
    
    child.unref();
  }
}

main();
