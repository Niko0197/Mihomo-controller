// clients_manager.js
// Модуль для обнаружения клиентов, ведения базы имен, подсчета трафика и переключения правил VPN

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const configPath = '/opt/etc/mihomo/config.yaml';
const dbPath = path.join(__dirname, 'clients_db.json');

const API_HOST = '192.168.1.1';
const API_PORT = 9090;

// Локальная база кастомных имен
let clientsDb = {};
try {
  if (fs.existsSync(dbPath)) {
    clientsDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  }
} catch (e) {
  console.error('Ошибка загрузки базы имен клиентов:', e.message);
}

// Накопленный трафик клиентов в памяти: IP => { vpnDownload, vpnUpload, directDownload, directUpload }
const cumulativeTraffic = new Map();

// Текущие скорости клиентов (байт в сек): IP => { downSpeed, upSpeed }
const currentSpeeds = new Map();

// Последние зафиксированные байты активных соединений (для расчета дельт)
// id => { ip, isVpn, download, upload }
const trackedConnections = new Map();

// Сохранение базы имен
function saveDb() {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(clientsDb, null, 2), 'utf8');
  } catch (err) {
    console.error('Ошибка сохранения базы имен клиентов:', err.message);
  }
}

// Переименование клиента
function renameClient(ip, name) {
  if (!ip) return false;
  if (!name || name.trim() === '') {
    delete clientsDb[ip];
  } else {
    clientsDb[ip] = name.trim();
  }
  saveDb();
  return true;
}

// Вспомогательная функция для отправки локального запроса к API Mihomo
function makeMihomoRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path: endpoint,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 3000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });

    req.on('error', reject);
    req.on('timeout', () => { 
      req.destroy(); 
      reject(new Error('Mihomo API Timeout')); 
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Парсинг заблокированных (bypassed) клиентов из config.yaml (между маркерами)
function getBypassedClients() {
  const list = new Set();
  try {
    if (!fs.existsSync(configPath)) return list;
    const yamlText = fs.readFileSync(configPath, 'utf8');
    const lines = yamlText.split(/\r?\n/);
    
    let inBypassBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '# --- CLIENTS BYPASS RULES ---') {
        inBypassBlock = true;
        continue;
      }
      if (line === '# --- END CLIENTS BYPASS RULES ---') {
        inBypassBlock = false;
        break;
      }
      if (inBypassBlock && line.startsWith('- SRC-IP-CIDR,')) {
        // Формат: - SRC-IP-CIDR,192.168.1.48/32,DIRECT
        const parts = line.split(',');
        if (parts.length >= 3) {
          const ipWithCidr = parts[1].trim();
          const ip = ipWithCidr.split('/')[0];
          list.add(ip);
        }
      }
    }
  } catch (err) {
    console.error('Ошибка чтения исключенных клиентов из конфига:', err.message);
  }
  return list;
}

// Включение/выключение VPN для клиента (Способ А)
async function toggleClientVpn(ip, vpnEnabled) {
  if (!ip) throw new Error('IP адрес не указан');
  
  if (!fs.existsSync(configPath)) {
    throw new Error('Конфиг config.yaml не найден');
  }

  let yamlText = fs.readFileSync(configPath, 'utf8');
  let lines = yamlText.split(/\r?\n/);
  
  let startMarkerIdx = lines.findIndex(l => l.trim() === '# --- CLIENTS BYPASS RULES ---');
  let endMarkerIdx = lines.findIndex(l => l.trim() === '# --- END CLIENTS BYPASS RULES ---');
  
  // Если маркеров нет, создаем их в начале секции rules:
  if (startMarkerIdx === -1 || endMarkerIdx === -1) {
    const rulesIdx = lines.findIndex(l => l.trim() === 'rules:');
    if (rulesIdx === -1) {
      throw new Error('Секция rules: не найдена в конфиге');
    }
    
    lines.splice(rulesIdx + 1, 0, 
      '  # --- CLIENTS BYPASS RULES ---',
      '  # --- END CLIENTS BYPASS RULES ---'
    );
    
    startMarkerIdx = rulesIdx + 1;
    endMarkerIdx = rulesIdx + 2;
  }

  const bypassRule = `  - SRC-IP-CIDR,${ip}/32,DIRECT`;
  let yamlChanged = false;
  
  const ruleIdx = lines.findIndex((l, idx) => 
    idx > startMarkerIdx && 
    idx < endMarkerIdx && 
    l.trim().startsWith(`- SRC-IP-CIDR,${ip}/32,`)
  );

  if (vpnEnabled === false) {
    // Выключаем VPN (добавляем обход DIRECT)
    if (ruleIdx === -1) {
      lines.splice(endMarkerIdx, 0, bypassRule);
      yamlChanged = true;
    }
  } else {
    // Включаем VPN обратно (удаляем правило DIRECT)
    if (ruleIdx !== -1) {
      lines.splice(ruleIdx, 1);
      yamlChanged = true;
    }
  }

  if (yamlChanged) {
    fs.writeFileSync(configPath, lines.join('\n'), 'utf8');
    
    // Перезагрузка конфигурации в Mihomo
    try {
      const reloadRes = await makeMihomoRequest('PUT', '/configs', { path: configPath });
      if (reloadRes.statusCode !== 200 && reloadRes.statusCode !== 204) {
        throw new Error('Код ответа API: ' + reloadRes.statusCode);
      }
    } catch (err) {
      throw new Error('Не удалось применить настройки в Mihomo: ' + err.message);
    }
  }
  
  return true;
}

// Запуск фонового сбора трафика по клиентам (каждые 2 секунды)
function startTrafficTracker() {
  let lastPollTime = Date.now();

  setInterval(async () => {
    try {
      const res = await makeMihomoRequest('GET', '/connections');
      if (res.statusCode !== 200) return;
      
      const data = JSON.parse(res.data);
      const connections = data.connections || [];
      const currentActiveIds = new Set();
      const now = Date.now();
      const deltaSec = (now - lastPollTime) / 1000 || 2;
      lastPollTime = now;

      // Временный маппинг скоростей за этот тик
      const speedsThisTick = new Map(); // IP => { downBytes, upBytes }

      connections.forEach(conn => {
        const id = conn.id;
        const ip = conn.metadata.sourceIP;
        if (!ip) return;

        currentActiveIds.add(id);

        // Определяем, VPN или DIRECT соединение
        const chain = conn.chains || [];
        const isVpn = chain.length > 0 && chain[chain.length - 1] !== 'DIRECT';

        // Получаем или инициализируем накопительный трафик для этого IP
        if (!cumulativeTraffic.has(ip)) {
          cumulativeTraffic.set(ip, { vpnDownload: 0, vpnUpload: 0, directDownload: 0, directUpload: 0 });
        }
        const accum = cumulativeTraffic.get(ip);

        // Инициализируем временный контейнер скоростей
        if (!speedsThisTick.has(ip)) {
          speedsThisTick.set(ip, { downBytes: 0, upBytes: 0 });
        }
        const speedObj = speedsThisTick.get(ip);

        const lastTrack = trackedConnections.get(id);
        if (lastTrack) {
          // Вычисляем дельты
          const dDownload = Math.max(0, conn.download - lastTrack.download);
          const dUpload = Math.max(0, conn.upload - lastTrack.upload);

          if (isVpn) {
            accum.vpnDownload += dDownload;
            accum.vpnUpload += dUpload;
          } else {
            accum.directDownload += dDownload;
            accum.directUpload += dUpload;
          }

          speedObj.downBytes += dDownload;
          speedObj.upBytes += dUpload;

          // Обновляем состояние отслеживания
          lastTrack.download = conn.download;
          lastTrack.upload = conn.upload;
        } else {
          // Новое соединение: учитываем его стартовый объем с нуля
          if (isVpn) {
            accum.vpnDownload += conn.download;
            accum.vpnUpload += conn.upload;
          } else {
            accum.directDownload += conn.download;
            accum.directUpload += conn.upload;
          }

          speedObj.downBytes += conn.download;
          speedObj.upBytes += conn.upload;

          trackedConnections.set(id, {
            ip,
            isVpn,
            download: conn.download,
            upload: conn.upload
          });
        }
      });

      // Удаляем закрытые соединения
      for (const [id, track] of trackedConnections.entries()) {
        if (!currentActiveIds.has(id)) {
          trackedConnections.delete(id);
        }
      }

      // Пересчитываем текущие скорости для каждого IP
      currentSpeeds.clear();
      for (const [ip, s] of speedsThisTick.entries()) {
        currentSpeeds.set(ip, {
          downSpeed: Math.round(s.downBytes / deltaSec),
          upSpeed: Math.round(s.upBytes / deltaSec)
        });
      }
    } catch (err) {
      // Игнорируем временные ошибки API при перезапуске Mihomo
    }
  }, 2000);
}

// Запуск трекера
startTrafficTracker();

// Получение списка клиентов
function getClientsList() {
  const clientsMap = new Map(); // IP => clientObj
  
  // 1. Получаем исключенных клиентов из конфига
  const bypassed = getBypassedClients();

  // 2. Сканируем таблицу ARP (ip neigh) для обнаружения активных хостов в локальной сети
  try {
    const neighOutput = execSync('ip neigh show', { timeout: 2000 }).toString();
    const lines = neighOutput.split('\n');

    lines.forEach(line => {
      // Ищем только REACHABLE и STALE IPv4 хосты
      if (!line.includes('REACHABLE') && !line.includes('STALE') && !line.includes('DELAY')) return;
      
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        const ip = parts[0];
        // Валидация IPv4
        if (!ip.match(/^([0-9]{1,3}\.){3}[0-9]{1,3}$/)) return;
        
        let mac = '';
        const lladdrIdx = parts.indexOf('lladdr');
        if (lladdrIdx !== -1 && lladdrIdx + 1 < parts.length) {
          mac = parts[lladdrIdx + 1].toUpperCase();
        }

        if (ip && ip !== '192.168.1.1') {
          clientsMap.set(ip, {
            ip,
            mac,
            name: clientsDb[ip] || '',
            vpnEnabled: !bypassed.has(ip),
            active: line.includes('REACHABLE') || line.includes('DELAY'),
            downSpeed: 0,
            upSpeed: 0,
            vpnDownload: 0,
            vpnUpload: 0,
            directDownload: 0,
            directUpload: 0
          });
        }
      }
    });
  } catch (err) {
    console.error('Ошибка выполнения ip neigh:', err.message);
  }

  // 3. Добавляем тех клиентов, которые сейчас не в ip neigh, но по которым шел трафик (если есть)
  for (const ip of cumulativeTraffic.keys()) {
    if (!clientsMap.has(ip) && ip !== '127.0.0.1' && ip !== '192.168.1.1') {
      clientsMap.set(ip, {
        ip,
        mac: '',
        name: clientsDb[ip] || '',
        vpnEnabled: !bypassed.has(ip),
        active: false,
        downSpeed: 0,
        upSpeed: 0,
        vpnDownload: 0,
        vpnUpload: 0,
        directDownload: 0,
        directUpload: 0
      });
    }
  }

  // 4. Подтягиваем скорости и кумулятивный трафик
  const list = [];
  for (const client of clientsMap.values()) {
    const speed = currentSpeeds.get(client.ip);
    if (speed) {
      client.downSpeed = speed.downSpeed;
      client.upSpeed = speed.upSpeed;
      client.active = true; // Если есть скорость обмена данными, устройство точно активно
    }

    const traffic = cumulativeTraffic.get(client.ip);
    if (traffic) {
      client.vpnDownload = traffic.vpnDownload;
      client.vpnUpload = traffic.vpnUpload;
      client.directDownload = traffic.directDownload;
      client.directUpload = traffic.directUpload;
    }

    list.push(client);
  }

  // Сортировка: сначала активные устройства, затем по IP
  return list.sort((a, b) => {
    if (a.active !== b.active) return b.active - a.active;
    const partsA = a.ip.split('.').map(Number);
    const partsB = b.ip.split('.').map(Number);
    for (let i = 0; i < 4; i++) {
      if (partsA[i] !== partsB[i]) return partsA[i] - partsB[i];
    }
    return 0;
  });
}

module.exports = {
  getClientsList,
  toggleClientVpn,
  renameClient
};
