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

// Вспомогательные функции для работы со структурированной БД клиентов (совместимой со строками)
function getClientData(key) {
  const entry = clientsDb[key];
  if (!entry) return { name: '', group: '' };
  if (typeof entry === 'string') {
    return { name: entry, group: '' };
  }
  return {
    name: entry.name || '',
    group: entry.group || ''
  };
}

function setClientName(key, name) {
  if (!clientsDb[key]) {
    clientsDb[key] = { name: '', group: '' };
  } else if (typeof clientsDb[key] === 'string') {
    clientsDb[key] = { name: clientsDb[key], group: '' };
  }
  clientsDb[key].name = name.trim();
  if (!clientsDb[key].name && !clientsDb[key].group) {
    delete clientsDb[key];
  }
}

function setClientGroup(key, group) {
  if (!clientsDb[key]) {
    clientsDb[key] = { name: '', group: '' };
  } else if (typeof clientsDb[key] === 'string') {
    clientsDb[key] = { name: clientsDb[key], group: '' };
  }
  clientsDb[key].group = group.trim();
  if (!clientsDb[key].name && !clientsDb[key].group) {
    delete clientsDb[key];
  }
}

// Вспомогательная функция для декодирования XML-сущностей
function unescapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Парсинг XML ответа hotspot в массив объектов хостов
function parseHotspotXml(xmlString) {
  const hosts = [];
  if (!xmlString) return hosts;
  
  const hostRegex = /<host>([\s\S]*?)<\/host>/g;
  let match;
  while ((match = hostRegex.exec(xmlString)) !== null) {
    const hostContent = match[1];
    
    const macMatch = hostContent.match(/<mac>([^<]*)<\/mac>/);
    const ipMatch = hostContent.match(/<ip>([^<]*)<\/ip>/);
    const hostnameMatch = hostContent.match(/<hostname>([^<]*)<\/hostname>/);
    const nameMatch = hostContent.match(/<name>([^<]*)<\/name>/);
    
    if (macMatch) {
      hosts.push({
        mac: macMatch[1].trim().toUpperCase(),
        ip: ipMatch ? ipMatch[1].trim() : '',
        hostname: hostnameMatch ? unescapeXml(hostnameMatch[1].trim()) : '',
        name: nameMatch ? unescapeXml(nameMatch[1].trim()) : ''
      });
    }
  }
  return hosts;
}

// Получение списка хостов из Keenetic через ndmq с кэшированием
let cachedHotspotHosts = [];
let lastHotspotFetchTime = 0;
const CACHE_TTL_MS = 15000; // 15 секунд

function getHotspotHosts() {
  const now = Date.now();
  if (now - lastHotspotFetchTime < CACHE_TTL_MS && cachedHotspotHosts.length > 0) {
    return cachedHotspotHosts;
  }
  
  try {
    const xmlOutput = execSync('/opt/bin/ndmq -x -p "show ip hotspot"', { timeout: 3000 }).toString();
    cachedHotspotHosts = parseHotspotXml(xmlOutput);
    lastHotspotFetchTime = now;
  } catch (err) {
    console.error('Ошибка получения данных hotspot через ndmq:', err.message);
  }
  return cachedHotspotHosts;
}

// Приоритетное разрешение имени устройства
function resolveClientName(ip, mac, hostByMac, hostByIp) {
  const normMac = mac ? mac.toUpperCase() : '';
  
  // 1. Кастомное имя по MAC-адресу из БД
  if (normMac) {
    const data = getClientData(normMac);
    if (data.name) return data.name;
  }
  // 2. Кастомное имя по IP-адресу из БД (совместимость)
  if (ip) {
    const data = getClientData(ip);
    if (data.name) return data.name;
  }
  
  // Ищем хост в hotspot по MAC или IP
  let h = null;
  if (normMac) {
    h = hostByMac.get(normMac);
  }
  if (!h && ip) {
    h = hostByIp.get(ip);
  }
  
  if (h) {
    // 3. Заданное пользователем в Keenetic имя (<name>)
    if (h.name) return h.name;
    // 4. Заводское имя хоста (<hostname>)
    if (h.hostname) return h.hostname;
  }
  
  return '';
}

// Разрешение сохраненной предпочтительной группы
function resolveClientGroup(ip, mac) {
  const normMac = mac ? mac.toUpperCase() : '';
  if (normMac) {
    const data = getClientData(normMac);
    if (data.group) return data.group;
  }
  if (ip) {
    const data = getClientData(ip);
    if (data.group) return data.group;
  }
  return '';
}

// Переименование клиента
function renameClient(ip, name) {
  if (!ip) return false;
  
  // Пытаемся найти MAC по IP-адресу в текущем списке клиентов
  let mac = '';
  try {
    const list = getClientsList();
    const found = list.find(c => c.ip === ip);
    if (found && found.mac) {
      mac = found.mac.toUpperCase();
    }
  } catch (e) {
    console.error('Ошибка при определении MAC для переименования:', e.message);
  }

  const cleanName = name ? name.trim() : '';
  
  // Сохраняем по IP и по MAC для максимальной стабильности
  setClientName(ip, cleanName);
  if (mac) {
    setClientName(mac, cleanName);
  }
  
  saveDb();
  return true;
}

// Считывание текущих правил назначения прокси-групп по клиентам из config.yaml
// Считывание текущих правил назначения прокси-групп по клиентам из config.yaml
function getClientRulesFromConfig() {
  const rules = new Map(); // IP => groupName
  try {
    if (!fs.existsSync(configPath)) return rules;
    const yamlText = fs.readFileSync(configPath, 'utf8');
    const lines = yamlText.split(/\r?\n/);
    
    const parseBlock = (startMarker, endMarker) => {
      let inBlock = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === startMarker) {
          inBlock = true;
          continue;
        }
        if (line === endMarker) {
          inBlock = false;
          continue;
        }
        if (inBlock && line.startsWith('- SRC-IP-CIDR,')) {
          const parts = line.split(',');
          if (parts.length >= 3) {
            const ipWithCidr = parts[1].trim();
            const ip = ipWithCidr.split('/')[0];
            const groupName = parts[2].trim().replace(/^['"]|['"]$/g, '');
            rules.set(ip, groupName);
          }
        }
      }
    };

    parseBlock('# --- CLIENTS BYPASS RULES ---', '# --- END CLIENTS BYPASS RULES ---');
    parseBlock('# --- CLIENTS VPN RULES ---', '# --- END CLIENTS VPN RULES ---');

  } catch (err) {
    console.error('Ошибка чтения правил клиентов из конфига:', err.message);
  }
  return rules;
}

// Запись или замена правила для конкретного клиента в config.yaml
async function setClientRuleInConfig(ip, targetGroup) {
  if (!ip) throw new Error('IP адрес не указан');
  if (!targetGroup) throw new Error('Группа не указана');
  
  if (!fs.existsSync(configPath)) {
    throw new Error('Конфиг config.yaml не найден');
  }

  let yamlText = fs.readFileSync(configPath, 'utf8');
  let lines = yamlText.split(/\r?\n/);
  
  // Ищем маркеры для обоих блоков
  let startBypassIdx = lines.findIndex(l => l.trim() === '# --- CLIENTS BYPASS RULES ---');
  let endBypassIdx = lines.findIndex(l => l.trim() === '# --- END CLIENTS BYPASS RULES ---');
  
  let startVpnIdx = lines.findIndex(l => l.trim() === '# --- CLIENTS VPN RULES ---');
  let endVpnIdx = lines.findIndex(l => l.trim() === '# --- END CLIENTS VPN RULES ---');
  
  // Инициализация блока DIRECT правил (в самом верху rules:)
  if (startBypassIdx === -1 || endBypassIdx === -1) {
    const rulesIdx = lines.findIndex(l => l.trim() === 'rules:');
    if (rulesIdx === -1) {
      throw new Error('Секция rules: не найдена в конфиге');
    }
    lines.splice(rulesIdx + 1, 0, 
      '  # --- CLIENTS BYPASS RULES ---',
      '  # --- END CLIENTS BYPASS RULES ---'
    );
    startBypassIdx = rulesIdx + 1;
    endBypassIdx = rulesIdx + 2;
    // Корректируем индексы VPN
    if (startVpnIdx !== -1) startVpnIdx += 2;
    if (endVpnIdx !== -1) endVpnIdx += 2;
  }
  
  // Инициализация блока VPN правил (в самом низу rules:, перед MATCH)
  if (startVpnIdx === -1 || endVpnIdx === -1) {
    let matchIdx = lines.findIndex(l => l.trim().startsWith('- MATCH,'));
    if (matchIdx === -1) {
      matchIdx = lines.length - 1;
    }
    lines.splice(matchIdx, 0, 
      '  # --- CLIENTS VPN RULES ---',
      '  # --- END CLIENTS VPN RULES ---'
    );
    startVpnIdx = matchIdx;
    endVpnIdx = matchIdx + 1;
  }

  let yamlChanged = false;
  const isDefault = targetGroup.toLowerCase() === 'default';
  const isDirect = targetGroup.toLowerCase() === 'direct';

  const removeRuleFromBlock = (startIdx, endIdx) => {
    const idx = lines.findIndex((l, i) => 
      i > startIdx && 
      i < endIdx && 
      l.trim().startsWith(`- SRC-IP-CIDR,${ip}/32,`)
    );
    if (idx !== -1) {
      lines.splice(idx, 1);
      yamlChanged = true;
      return idx;
    }
    return -1;
  };

  if (isDefault) {
    // Удаляем из обоих блоков
    const removedBypass = removeRuleFromBlock(startBypassIdx, endBypassIdx);
    if (removedBypass !== -1) {
      if (startVpnIdx > removedBypass) startVpnIdx--;
      if (endVpnIdx > removedBypass) endVpnIdx--;
    }
    removeRuleFromBlock(startVpnIdx, endVpnIdx);
  } else if (isDirect) {
    // Удаляем из блока VPN
    removeRuleFromBlock(startVpnIdx, endVpnIdx);
    
    // Гарантируем наличие в блоке Bypass (DIRECT)
    let ruleIdx = lines.findIndex((l, idx) => 
      idx > startBypassIdx && 
      idx < endBypassIdx && 
      l.trim().startsWith(`- SRC-IP-CIDR,${ip}/32,`)
    );
    const newRule = `  - SRC-IP-CIDR,${ip}/32,${targetGroup}`;
    if (ruleIdx !== -1) {
      const currentRule = lines[ruleIdx].trim();
      if (currentRule !== `- SRC-IP-CIDR,${ip}/32,${targetGroup}`) {
        lines[ruleIdx] = newRule;
        yamlChanged = true;
      }
    } else {
      lines.splice(endBypassIdx, 0, newRule);
      yamlChanged = true;
    }
  } else {
    // VPN группа
    // Удаляем из блока Bypass (DIRECT)
    const removedBypass = removeRuleFromBlock(startBypassIdx, endBypassIdx);
    if (removedBypass !== -1) {
      if (startVpnIdx > removedBypass) startVpnIdx--;
      if (endVpnIdx > removedBypass) endVpnIdx--;
    }
    
    // Гарантируем наличие в блоке VPN
    let ruleIdx = lines.findIndex((l, idx) => 
      idx > startVpnIdx && 
      idx < endVpnIdx && 
      l.trim().startsWith(`- SRC-IP-CIDR,${ip}/32,`)
    );
    const newRule = `  - SRC-IP-CIDR,${ip}/32,${targetGroup}`;
    if (ruleIdx !== -1) {
      const currentRule = lines[ruleIdx].trim();
      if (currentRule !== `- SRC-IP-CIDR,${ip}/32,${targetGroup}`) {
        lines[ruleIdx] = newRule;
        yamlChanged = true;
      }
    } else {
      lines.splice(endVpnIdx, 0, newRule);
      yamlChanged = true;
    }
  }

  if (yamlChanged) {
    fs.writeFileSync(configPath, lines.join('\n'), 'utf8');
    
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

// Установка/сохранение предпочтительной группы клиента
async function setClientGroupPreference(ip, group) {
  if (!ip) throw new Error('IP адрес не указан');
  if (!group) throw new Error('Группа не указана');
  
  // Пытаемся определить MAC устройства
  let mac = '';
  try {
    const list = getClientsList();
    const found = list.find(c => c.ip === ip);
    if (found && found.mac) {
      mac = found.mac.toUpperCase();
    }
  } catch (e) {
    console.error('Ошибка при определении MAC для смены группы:', e.message);
  }

  // Сохраняем группу в БД под обоими ключами
  setClientGroup(ip, group);
  if (mac) {
    setClientGroup(mac, group);
  }
  saveDb();

  // Если VPN в данный момент включен (то есть устройство не идет через DIRECT),
  // сразу же обновляем правило в config.yaml на новую выбранную группу!
  const activeRules = getClientRulesFromConfig();
  const currentRuleGroup = activeRules.get(ip) || '';
  
  if (currentRuleGroup !== 'DIRECT') {
    await setClientRuleInConfig(ip, group);
  }
  
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

// Включение/выключение VPN для клиента (Способ А)
async function toggleClientVpn(ip, vpnEnabled) {
  if (!ip) throw new Error('IP адрес не указан');
  
  if (vpnEnabled === false) {
    // Если VPN выключается, направляем трафик через DIRECT
    return setClientRuleInConfig(ip, 'DIRECT');
  } else {
    // Если VPN включается, восстанавливаем предпочтительную группу или берем дефолтную
    let mac = '';
    try {
      const list = getClientsList();
      const found = list.find(c => c.ip === ip);
      if (found && found.mac) {
        mac = found.mac.toUpperCase();
      }
    } catch (e) {}

    const preferredGroup = resolveClientGroup(ip, mac);
    const defaultGroup = '🚀Auto-Best';
    return setClientRuleInConfig(ip, (preferredGroup && preferredGroup !== 'default') ? preferredGroup : defaultGroup);
  }
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
        if (!ip || !ip.startsWith('192.')) return;

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
  
  // Получаем текущие правила назначения прокси-групп из конфига
  const activeRules = getClientRulesFromConfig();

  // Получаем список hotspot устройств для сопоставления имен
  const hotspotHosts = getHotspotHosts();
  const hostByMac = new Map();
  const hostByIp = new Map();
  hotspotHosts.forEach(h => {
    if (h.mac) hostByMac.set(h.mac, h);
    if (h.ip && h.ip !== '0.0.0.0') hostByIp.set(h.ip, h);
  });

  // Вспомогательная функция для сборки объекта клиента
  function buildClientObj(ip, mac, active) {
    const name = resolveClientName(ip, mac, hostByMac, hostByIp);
    const savedGroup = resolveClientGroup(ip, mac);
    const currentRuleGroup = activeRules.get(ip) || '';
    
    // VPN включен, если текущее правило в конфиге НЕ равно DIRECT
    const vpnEnabled = currentRuleGroup !== 'DIRECT';
    
    // Выбранная группа для выпадающего списка: сохраненное предпочтение, 
    // либо активное правило в конфиге (если оно не DIRECT), либо по умолчанию '🚀Auto-Best'
    let group = savedGroup || (currentRuleGroup && currentRuleGroup !== 'DIRECT' ? currentRuleGroup : '🚀Auto-Best');
    if (group === 'default') group = '🚀Auto-Best';
    
    return {
      ip,
      mac,
      name,
      group,
      vpnEnabled,
      active,
      downSpeed: 0,
      upSpeed: 0,
      vpnDownload: 0,
      vpnUpload: 0,
      directDownload: 0,
      directUpload: 0
    };
  }

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
        if (!ip.startsWith('192.')) return;
        
        let mac = '';
        const lladdrIdx = parts.indexOf('lladdr');
        if (lladdrIdx !== -1 && lladdrIdx + 1 < parts.length) {
          mac = parts[lladdrIdx + 1].toUpperCase();
        }

        if (ip && ip !== '192.168.1.1') {
          clientsMap.set(ip, buildClientObj(ip, mac, line.includes('REACHABLE') || line.includes('DELAY')));
        }
      }
    });
  } catch (err) {
    console.error('Ошибка выполнения ip neigh:', err.message);
  }

  // Добавляем активных клиентов из hotspot, которых нет в ARP таблице
  hotspotHosts.forEach(h => {
    if (h.active === 'yes' && h.ip && h.ip.startsWith('192.') && h.ip !== '192.168.1.1' && !clientsMap.has(h.ip)) {
      clientsMap.set(h.ip, buildClientObj(h.ip, h.mac, true));
    }
  });

  // 3. Добавляем тех клиентов, которые сейчас не в ip neigh, но по которым шел трафик (если есть)
  for (const ip of cumulativeTraffic.keys()) {
    if (ip.startsWith('192.') && !clientsMap.has(ip) && ip !== '127.0.0.1' && ip !== '192.168.1.1') {
      const h = hostByIp.get(ip);
      const mac = h ? h.mac : '';
      clientsMap.set(ip, buildClientObj(ip, mac, false));
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
  renameClient,
  setClientGroupPreference
};
