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

// Кэш привязок IP к MAC адресам (в памяти)
const ipToMacCache = new Map();

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

// --- База данных накопленного трафика ---
const trafficDbPath = path.join(__dirname, 'traffic_db.json');
let trafficDb = { lastUpdated: new Date().toISOString(), clients: {} };

try {
  if (fs.existsSync(trafficDbPath)) {
    trafficDb = JSON.parse(fs.readFileSync(trafficDbPath, 'utf8'));
    if (!trafficDb.clients) {
      trafficDb.clients = {};
    }
  } else {
    fs.writeFileSync(trafficDbPath, JSON.stringify(trafficDb, null, 2), 'utf8');
  }
} catch (e) {
  console.error('Ошибка загрузки базы данных трафика:', e.message);
}

// Временное хранилище последнего сохраненного состояния cumulativeTraffic
const lastSavedTraffic = new Map();

function getYearMonthString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function saveTrafficDbSync() {
  try {
    const monthKey = getYearMonthString();
    let updated = false;

    for (const [ip, current] of cumulativeTraffic.entries()) {
      const last = lastSavedTraffic.get(ip) || { vpnDownload: 0, vpnUpload: 0, directDownload: 0, directUpload: 0 };
      
      const dVpnDn = Math.max(0, current.vpnDownload - last.vpnDownload);
      const dVpnUp = Math.max(0, current.vpnUpload - last.vpnUpload);
      const dDirDn = Math.max(0, current.directDownload - last.directDownload);
      const dDirUp = Math.max(0, current.directUpload - last.directUpload);

      if (dVpnDn > 0 || dVpnUp > 0 || dDirDn > 0 || dDirUp > 0) {
        let mac = ipToMacCache.get(ip);
        if (!mac) {
          try {
            const hosts = getHotspotHosts();
            const found = hosts.find(h => h.ip === ip);
            if (found && found.mac) {
              mac = found.mac.toUpperCase();
              ipToMacCache.set(ip, mac);
            }
          } catch (e) {}
        }
        
        const key = mac ? mac.toUpperCase() : ip;
        
        if (!trafficDb.clients[key]) {
          trafficDb.clients[key] = { monthly: {}, total: { vpnDownload: 0, vpnUpload: 0, directDownload: 0, directUpload: 0 } };
        }
        const clientEntry = trafficDb.clients[key];
        if (!clientEntry.monthly) clientEntry.monthly = {};
        if (!clientEntry.total) clientEntry.total = { vpnDownload: 0, vpnUpload: 0, directDownload: 0, directUpload: 0 };
        
        if (!clientEntry.monthly[monthKey]) {
          clientEntry.monthly[monthKey] = { vpnDownload: 0, vpnUpload: 0, directDownload: 0, directUpload: 0 };
        }
        
        const m = clientEntry.monthly[monthKey];
        m.vpnDownload += dVpnDn;
        m.vpnUpload += dVpnUp;
        m.directDownload += dDirDn;
        m.directUpload += dDirUp;

        const t = clientEntry.total;
        t.vpnDownload += dVpnDn;
        t.vpnUpload += dVpnUp;
        t.directDownload += dDirDn;
        t.directUpload += dDirUp;

        lastSavedTraffic.set(ip, {
          vpnDownload: current.vpnDownload,
          vpnUpload: current.vpnUpload,
          directDownload: current.directDownload,
          directUpload: current.directUpload
        });
        
        updated = true;
      }
    }

    trafficDb.lastUpdated = new Date().toISOString();
    fs.writeFileSync(trafficDbPath, JSON.stringify(trafficDb, null, 2), 'utf8');
  } catch (err) {
    console.error('Ошибка сохранения базы данных трафика (sync):', err.message);
  }
}

async function saveTrafficDb() {
  try {
    const monthKey = getYearMonthString();
    let updated = false;

    for (const [ip, current] of cumulativeTraffic.entries()) {
      const last = lastSavedTraffic.get(ip) || { vpnDownload: 0, vpnUpload: 0, directDownload: 0, directUpload: 0 };
      
      const dVpnDn = Math.max(0, current.vpnDownload - last.vpnDownload);
      const dVpnUp = Math.max(0, current.vpnUpload - last.vpnUpload);
      const dDirDn = Math.max(0, current.directDownload - last.directDownload);
      const dDirUp = Math.max(0, current.directUpload - last.directUpload);

      if (dVpnDn > 0 || dVpnUp > 0 || dDirDn > 0 || dDirUp > 0) {
        let mac = ipToMacCache.get(ip);
        if (!mac) {
          try {
            const hosts = getHotspotHosts();
            const found = hosts.find(h => h.ip === ip);
            if (found && found.mac) {
              mac = found.mac.toUpperCase();
              ipToMacCache.set(ip, mac);
            }
          } catch (e) {}
        }
        
        const key = mac ? mac.toUpperCase() : ip;
        
        if (!trafficDb.clients[key]) {
          trafficDb.clients[key] = { monthly: {}, total: { vpnDownload: 0, vpnUpload: 0, directDownload: 0, directUpload: 0 } };
        }
        const clientEntry = trafficDb.clients[key];
        if (!clientEntry.monthly) clientEntry.monthly = {};
        if (!clientEntry.total) clientEntry.total = { vpnDownload: 0, vpnUpload: 0, directDownload: 0, directUpload: 0 };
        
        if (!clientEntry.monthly[monthKey]) {
          clientEntry.monthly[monthKey] = { vpnDownload: 0, vpnUpload: 0, directDownload: 0, directUpload: 0 };
        }
        
        const m = clientEntry.monthly[monthKey];
        m.vpnDownload += dVpnDn;
        m.vpnUpload += dVpnUp;
        m.directDownload += dDirDn;
        m.directUpload += dDirUp;

        const t = clientEntry.total;
        t.vpnDownload += dVpnDn;
        t.vpnUpload += dVpnUp;
        t.directDownload += dDirDn;
        t.directUpload += dDirUp;

        lastSavedTraffic.set(ip, {
          vpnDownload: current.vpnDownload,
          vpnUpload: current.vpnUpload,
          directDownload: current.directDownload,
          directUpload: current.directUpload
        });
        
        updated = true;
      }
    }

    trafficDb.lastUpdated = new Date().toISOString();
    await fs.promises.writeFile(trafficDbPath, JSON.stringify(trafficDb, null, 2), 'utf8');
  } catch (err) {
    console.error('Ошибка сохранения базы данных трафика:', err.message);
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
    const activeMatch = hostContent.match(/<active>([^<]*)<\/active>/);
    
    if (macMatch) {
      hosts.push({
        mac: macMatch[1].trim().toUpperCase(),
        ip: ipMatch ? ipMatch[1].trim() : '',
        hostname: hostnameMatch ? unescapeXml(hostnameMatch[1].trim()) : '',
        name: nameMatch ? unescapeXml(nameMatch[1].trim()) : '',
        active: activeMatch ? activeMatch[1].trim() : 'no'
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
async function setClientRulesInConfig(ipsInput, targetGroup) {
  const ips = Array.isArray(ipsInput) ? ipsInput : [ipsInput];
  if (ips.length === 0) return false;
  if (!targetGroup) throw new Error('Группа не указана');
  
  if (!fs.existsSync(configPath)) {
    throw new Error('Конфиг config.yaml не найден');
  }

  let yamlText = fs.readFileSync(configPath, 'utf8');
  let lines = yamlText.split(/\r?\n/);
  
  const findIndices = () => {
    return {
      startBypassIdx: lines.findIndex(l => l.trim() === '# --- CLIENTS BYPASS RULES ---'),
      endBypassIdx: lines.findIndex(l => l.trim() === '# --- END CLIENTS BYPASS RULES ---'),
      startVpnIdx: lines.findIndex(l => l.trim() === '# --- CLIENTS VPN RULES ---'),
      endVpnIdx: lines.findIndex(l => l.trim() === '# --- END CLIENTS VPN RULES ---')
    };
  };

  let { startBypassIdx, endBypassIdx, startVpnIdx, endVpnIdx } = findIndices();
  
  if (startBypassIdx === -1 || endBypassIdx === -1) {
    const rulesIdx = lines.findIndex(l => l.trim() === 'rules:');
    if (rulesIdx === -1) {
      throw new Error('Секция rules: не найдена в конфиге');
    }
    lines.splice(rulesIdx + 1, 0, 
      '  # --- CLIENTS BYPASS RULES ---',
      '  # --- END CLIENTS BYPASS RULES ---'
    );
    const idxs = findIndices();
    startBypassIdx = idxs.startBypassIdx;
    endBypassIdx = idxs.endBypassIdx;
    startVpnIdx = idxs.startVpnIdx;
    endVpnIdx = idxs.endVpnIdx;
  }
  
  if (startVpnIdx === -1 || endVpnIdx === -1) {
    let matchIdx = lines.findIndex(l => l.trim().startsWith('- MATCH,'));
    if (matchIdx === -1) {
      matchIdx = lines.length - 1;
    }
    lines.splice(matchIdx, 0, 
      '  # --- CLIENTS VPN RULES ---',
      '  # --- END CLIENTS VPN RULES ---'
    );
    const idxs = findIndices();
    startBypassIdx = idxs.startBypassIdx;
    endBypassIdx = idxs.endBypassIdx;
    startVpnIdx = idxs.startVpnIdx;
    endVpnIdx = idxs.endVpnIdx;
  }

  let yamlChanged = false;
  const isDefault = targetGroup.toLowerCase() === 'default';
  const isDirect = targetGroup.toLowerCase() === 'direct';

  const removeRuleFromBlockForIp = (startIdx, endIdx, targetIp) => {
    const idx = lines.findIndex((l, i) => 
      i > startIdx && 
      i < endIdx && 
      (l.trim().startsWith(`- SRC-IP-CIDR,${targetIp}/32,`) || l.trim().startsWith(`- SRC-IP-CIDR,${targetIp}/128,`))
    );
    if (idx !== -1) {
      lines.splice(idx, 1);
      yamlChanged = true;
      return true;
    }
    return false;
  };

  for (const ip of ips) {
    const isIpv6 = ip.includes(':');
    const mask = isIpv6 ? '/128' : '/32';

    if (isDefault) {
      const removedBypass = removeRuleFromBlockForIp(startBypassIdx, endBypassIdx, ip);
      if (removedBypass) {
        const idxs = findIndices();
        startBypassIdx = idxs.startBypassIdx;
        endBypassIdx = idxs.endBypassIdx;
        startVpnIdx = idxs.startVpnIdx;
        endVpnIdx = idxs.endVpnIdx;
      }
      const removedVpn = removeRuleFromBlockForIp(startVpnIdx, endVpnIdx, ip);
      if (removedVpn) {
        const idxs = findIndices();
        startBypassIdx = idxs.startBypassIdx;
        endBypassIdx = idxs.endBypassIdx;
        startVpnIdx = idxs.startVpnIdx;
        endVpnIdx = idxs.endVpnIdx;
      }
    } else if (isDirect) {
      const removedVpn = removeRuleFromBlockForIp(startVpnIdx, endVpnIdx, ip);
      if (removedVpn) {
        const idxs = findIndices();
        startBypassIdx = idxs.startBypassIdx;
        endBypassIdx = idxs.endBypassIdx;
        startVpnIdx = idxs.startVpnIdx;
        endVpnIdx = idxs.endVpnIdx;
      }
      
      let ruleIdx = lines.findIndex((l, idx) => 
        idx > startBypassIdx && 
        idx < endBypassIdx && 
        (l.trim().startsWith(`- SRC-IP-CIDR,${ip}/32,`) || l.trim().startsWith(`- SRC-IP-CIDR,${ip}/128,`))
      );
      const newRule = `  - SRC-IP-CIDR,${ip}${mask},${targetGroup}`;
      if (ruleIdx !== -1) {
        const currentRule = lines[ruleIdx].trim();
        if (currentRule !== `- SRC-IP-CIDR,${ip}${mask},${targetGroup}`) {
          lines[ruleIdx] = newRule;
          yamlChanged = true;
        }
      } else {
        lines.splice(endBypassIdx, 0, newRule);
        yamlChanged = true;
        const idxs = findIndices();
        startBypassIdx = idxs.startBypassIdx;
        endBypassIdx = idxs.endBypassIdx;
        startVpnIdx = idxs.startVpnIdx;
        endVpnIdx = idxs.endVpnIdx;
      }
    } else {
      const removedBypass = removeRuleFromBlockForIp(startBypassIdx, endBypassIdx, ip);
      if (removedBypass) {
        const idxs = findIndices();
        startBypassIdx = idxs.startBypassIdx;
        endBypassIdx = idxs.endBypassIdx;
        startVpnIdx = idxs.startVpnIdx;
        endVpnIdx = idxs.endVpnIdx;
      }
      
      let ruleIdx = lines.findIndex((l, idx) => 
        idx > startVpnIdx && 
        idx < endVpnIdx && 
        (l.trim().startsWith(`- SRC-IP-CIDR,${ip}/32,`) || l.trim().startsWith(`- SRC-IP-CIDR,${ip}/128,`))
      );
      const newRule = `  - SRC-IP-CIDR,${ip}${mask},${targetGroup}`;
      if (ruleIdx !== -1) {
        const currentRule = lines[ruleIdx].trim();
        if (currentRule !== `- SRC-IP-CIDR,${ip}${mask},${targetGroup}`) {
          lines[ruleIdx] = newRule;
          yamlChanged = true;
        }
      } else {
        lines.splice(endVpnIdx, 0, newRule);
        yamlChanged = true;
        const idxs = findIndices();
        startBypassIdx = idxs.startBypassIdx;
        endBypassIdx = idxs.endBypassIdx;
        startVpnIdx = idxs.startVpnIdx;
        endVpnIdx = idxs.endVpnIdx;
      }
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
  
  let mac = '';
  let ips = [ip];
  try {
    const list = getClientsList();
    const found = list.find(c => c.ip === ip || (c.altIps && c.altIps.includes(ip)));
    if (found) {
      if (found.mac) mac = found.mac.toUpperCase();
      ips = [found.ip, ...(found.altIps || [])];
    }
  } catch (e) {
    console.error('Ошибка при определении MAC для смены группы:', e.message);
  }

  setClientGroup(ip, group);
  if (mac) {
    setClientGroup(mac, group);
  }
  for (const altIp of ips) {
    setClientGroup(altIp, group);
  }
  saveDb();

  const activeRules = getClientRulesFromConfig();
  const currentRuleGroup = activeRules.get(ip) || '';
  
  if (currentRuleGroup !== 'DIRECT') {
    await setClientRulesInConfig(ips, group);
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
  
  let ips = [ip];
  try {
    const list = getClientsList();
    const found = list.find(c => c.ip === ip || (c.altIps && c.altIps.includes(ip)));
    if (found) {
      ips = [found.ip, ...(found.altIps || [])];
    }
  } catch (e) {}

  if (vpnEnabled === false) {
    return setClientRulesInConfig(ips, 'DIRECT');
  } else {
    let mac = '';
    try {
      const list = getClientsList();
      const found = list.find(c => c.ip === ip || (c.altIps && c.altIps.includes(ip)));
      if (found && found.mac) {
        mac = found.mac.toUpperCase();
      }
    } catch (e) {}

    const preferredGroup = resolveClientGroup(ip, mac);
    const defaultGroup = '🚀Auto-Best';
    return setClientRulesInConfig(ips, (preferredGroup && preferredGroup !== 'default') ? preferredGroup : defaultGroup);
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
        if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '192.168.1.1') return;

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
  }, 1000);
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
    if (h.mac) hostByMac.set(h.mac.toUpperCase(), h);
    if (h.ip && h.ip !== '0.0.0.0') {
      hostByIp.set(h.ip, h);
      if (h.mac) {
        ipToMacCache.set(h.ip, h.mac.toUpperCase());
      }
    }
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
      directUpload: 0,
      vpnDownloadTotal: 0,
      vpnUploadTotal: 0,
      directDownloadTotal: 0,
      directUploadTotal: 0
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
        // Валидация IP (исключаем loopback)
        if (ip.startsWith('127.') || ip === '::1') return;
        
        let mac = '';
        const lladdrIdx = parts.indexOf('lladdr');
        if (lladdrIdx !== -1 && lladdrIdx + 1 < parts.length) {
          mac = parts[lladdrIdx + 1].toUpperCase();
        }

        if (ip && ip !== '192.168.1.1') {
          if (mac) {
            ipToMacCache.set(ip, mac);
          }
          clientsMap.set(ip, buildClientObj(ip, mac, line.includes('REACHABLE') || line.includes('DELAY')));
        }
      }
    });
  } catch (err) {
    console.error('Ошибка выполнения ip neigh:', err.message);
  }

  // Добавляем/обновляем статус клиентов из hotspot (включая неактивных/офлайн)
  hotspotHosts.forEach(h => {
    if (h.ip && h.ip !== '0.0.0.0' && h.ip !== '127.0.0.1' && h.ip !== '::1' && h.ip !== '192.168.1.1') {
      const isActive = (h.active === 'yes');
      const existing = clientsMap.get(h.ip);
      
      if (existing) {
        existing.active = isActive;
        if (h.mac && !existing.mac) {
          existing.mac = h.mac.toUpperCase();
        }
      } else {
        let macFound = null;
        if (h.mac) {
          const normMac = h.mac.toUpperCase();
          for (const c of clientsMap.values()) {
            if (c.mac && c.mac.toUpperCase() === normMac) {
              macFound = c;
              break;
            }
          }
        }
        
        if (macFound) {
          macFound.active = isActive;
        } else {
          clientsMap.set(h.ip, buildClientObj(h.ip, h.mac, isActive));
        }
      }
    }
  });

  // 3. Добавляем тех клиентов, которые сейчас не в ip neigh, но по которым шел трафик (если есть)
  for (const ip of cumulativeTraffic.keys()) {
    if (!clientsMap.has(ip) && ip !== '127.0.0.1' && ip !== '::1' && ip !== '192.168.1.1') {
      const h = hostByIp.get(ip);
      let mac = h ? h.mac : '';
      if (!mac) {
        mac = ipToMacCache.get(ip) || '';
      }
      clientsMap.set(ip, buildClientObj(ip, mac, false));
    }
  }

  // Вспомогательная функция для проверки приватных IPv4 адресов (RFC 1918)
  function isPrivateIp(ip) {
    if (!ip) return false;
    if (ip.startsWith('192.168.')) return true;
    if (ip.startsWith('172.')) {
      const parts = ip.split('.');
      if (parts.length >= 2) {
        const second = Number(parts[1]);
        return second >= 16 && second <= 31;
      }
    }
    if (ip.startsWith('10.') && !ip.startsWith('100.')) return true;
    return false;
  }

  // 4. Подтягиваем скорости и кумулятивный трафик, применяя жесткую очистку
  const list = [];
  for (const client of clientsMap.values()) {
    const normMac = client.mac ? client.mac.toUpperCase() : '';
    const hasCustomName = getClientData(normMac).name || getClientData(client.ip).name;
    const isInHotspot = normMac && hostByMac.has(normMac);
    const isLocal = isPrivateIp(client.ip);

    // ФИЛЬТР 1: Полностью скрываем устройства без MAC-адреса, если для них нет кастомного имени
    if (!normMac && !hasCustomName) {
      continue;
    }

    // ФИЛЬТР 2: Скрываем внешних соседей провайдера (если они не в хотспоте роутера, не имеют имени и IP не приватный локальный)
    if (!isInHotspot && !hasCustomName && !isLocal) {
      continue;
    }

    // ФИЛЬТР 3: Скрываем link-local IPv6 адреса самого роутера (fe80::) если нет кастомного имени
    if (client.ip.toLowerCase().startsWith('fe80:') && !isInHotspot && !hasCustomName) {
      continue;
    }

    const speed = currentSpeeds.get(client.ip);
    if (speed) {
      client.downSpeed = speed.downSpeed;
      client.upSpeed = speed.upSpeed;
      client.active = true;
    }

    list.push(client);
  }

  // --- Группировка по MAC-адресу для устранения дублей IPv6 ---
  const groupedByMac = new Map();
  const clientsWithoutMac = [];

  for (const client of list) {
    if (!client.mac) {
      clientsWithoutMac.push(client);
      continue;
    }
    const key = client.mac.toUpperCase();
    if (!groupedByMac.has(key)) {
      groupedByMac.set(key, []);
    }
    groupedByMac.get(key).push(client);
  }

  const mergedList = [...clientsWithoutMac];
  const isIpv6 = (ip) => ip.includes(':');

  for (const [mac, groupClients] of groupedByMac.entries()) {
    if (groupClients.length === 1) {
      mergedList.push(groupClients[0]);
      continue;
    }

    let mainClient = groupClients.find(c => !isIpv6(c.ip));
    if (!mainClient) {
      mainClient = groupClients.find(c => isIpv6(c.ip) && !c.ip.toLowerCase().startsWith('fe80:'));
    }
    if (!mainClient) {
      mainClient = groupClients[0];
    }

    const altIps = [];
    for (const other of groupClients) {
      if (other.ip !== mainClient.ip) {
        altIps.push(other.ip);
        mainClient.downSpeed += other.downSpeed;
        mainClient.upSpeed += other.upSpeed;
        if (other.active) {
          mainClient.active = true;
        }
      }
    }

    if (altIps.length > 0) {
      mainClient.altIps = altIps;
    }

    mergedList.push(mainClient);
  }

  // --- Наполнение трафиком из базы данных и несохраненных дельт ---
  const monthKey = getYearMonthString();
  for (const client of mergedList) {
    const key = client.mac ? client.mac.toUpperCase() : client.ip;
    const dbEntry = trafficDb.clients[key];
    
    const dbVpnDownload = dbEntry?.monthly?.[monthKey]?.vpnDownload || 0;
    const dbVpnUpload = dbEntry?.monthly?.[monthKey]?.vpnUpload || 0;
    const dbDirectDownload = dbEntry?.monthly?.[monthKey]?.directDownload || 0;
    const dbDirectUpload = dbEntry?.monthly?.[monthKey]?.directUpload || 0;

    const dbVpnDownloadTotal = dbEntry?.total?.vpnDownload || 0;
    const dbVpnUploadTotal = dbEntry?.total?.vpnUpload || 0;
    const dbDirectDownloadTotal = dbEntry?.total?.directDownload || 0;
    const dbDirectUploadTotal = dbEntry?.total?.directUpload || 0;

    // Считаем несохраненные дельты по всем IP-адресам этого клиента
    const ips = [client.ip, ...(client.altIps || [])];
    let unsavedVpnDownload = 0;
    let unsavedVpnUpload = 0;
    let unsavedDirectDownload = 0;
    let unsavedDirectUpload = 0;

    for (const ip of ips) {
      const current = cumulativeTraffic.get(ip);
      if (current) {
        const last = lastSavedTraffic.get(ip) || { vpnDownload: 0, vpnUpload: 0, directDownload: 0, directUpload: 0 };
        unsavedVpnDownload += Math.max(0, current.vpnDownload - last.vpnDownload);
        unsavedVpnUpload += Math.max(0, current.vpnUpload - last.vpnUpload);
        unsavedDirectDownload += Math.max(0, current.directDownload - last.directDownload);
        unsavedDirectUpload += Math.max(0, current.directUpload - last.directUpload);
      }
    }

    client.vpnDownload = dbVpnDownload + unsavedVpnDownload;
    client.vpnUpload = dbVpnUpload + unsavedVpnUpload;
    client.directDownload = dbDirectDownload + unsavedDirectDownload;
    client.directUpload = dbDirectUpload + unsavedDirectUpload;

    client.vpnDownloadTotal = dbVpnDownloadTotal + unsavedVpnDownload;
    client.vpnUploadTotal = dbVpnUploadTotal + unsavedVpnUpload;
    client.directDownloadTotal = dbDirectDownloadTotal + unsavedDirectDownload;
    client.directUploadTotal = dbDirectUploadTotal + unsavedDirectUpload;
  }

  // Сортировка: сначала активные устройства, затем IPv4, затем IPv6
  return mergedList.sort((a, b) => {
    if (a.active !== b.active) return b.active - a.active;
    
    const isA_ipv6 = a.ip.includes(':');
    const isB_ipv6 = b.ip.includes(':');
    
    if (isA_ipv6 && !isB_ipv6) return 1;
    if (!isA_ipv6 && isB_ipv6) return -1;
    
    if (!isA_ipv6 && !isB_ipv6) {
      const partsA = a.ip.split('.').map(Number);
      const partsB = b.ip.split('.').map(Number);
      for (let i = 0; i < 4; i++) {
        if (partsA[i] !== partsB[i]) return partsA[i] - partsB[i];
      }
      return 0;
    }
    
    return a.ip.localeCompare(b.ip);
  });
}

// Отключение VPN для всех клиентов (перевод в DIRECT)
async function disableVpnForAllClients() {
  if (!fs.existsSync(configPath)) {
    throw new Error('Конфиг config.yaml не найден');
  }

  let yamlText = fs.readFileSync(configPath, 'utf8');
  let lines = yamlText.split(/\r?\n/);
  
  let startBypassIdx = lines.findIndex(l => l.trim() === '# --- CLIENTS BYPASS RULES ---');
  let endBypassIdx = lines.findIndex(l => l.trim() === '# --- END CLIENTS BYPASS RULES ---');
  
  let startVpnIdx = lines.findIndex(l => l.trim() === '# --- CLIENTS VPN RULES ---');
  let endVpnIdx = lines.findIndex(l => l.trim() === '# --- END CLIENTS VPN RULES ---');
  
  if (startBypassIdx === -1 || endBypassIdx === -1 || startVpnIdx === -1 || endVpnIdx === -1) {
    return false;
  }

  // Находим все правила в блоке VPN
  const vpnRules = [];
  for (let i = startVpnIdx + 1; i < endVpnIdx; i++) {
    const line = lines[i].trim();
    if (line.startsWith('- SRC-IP-CIDR,')) {
      vpnRules.push(line);
    }
  }

  if (vpnRules.length === 0) return false; // Нет клиентов с включенным VPN

  // Удаляем их из блока VPN
  lines.splice(startVpnIdx + 1, endVpnIdx - startVpnIdx - 1);
  
  // Пересчитываем индексы
  startBypassIdx = lines.findIndex(l => l.trim() === '# --- CLIENTS BYPASS RULES ---');
  endBypassIdx = lines.findIndex(l => l.trim() === '# --- END CLIENTS BYPASS RULES ---');

  // Преобразуем правила в DIRECT и добавляем в Bypass блок
  const directRules = vpnRules.map(r => {
    const parts = r.split(',');
    parts[2] = 'DIRECT';
    return '  ' + parts.join(',');
  });

  // Отфильтровываем дубликаты
  const existingBypassRules = lines.slice(startBypassIdx + 1, endBypassIdx);
  const newDirectRules = directRules.filter(newRule => {
    const newIp = newRule.split(',')[1];
    return !existingBypassRules.some(extRule => extRule.split(',')[1] === newIp);
  });

  lines.splice(endBypassIdx, 0, ...newDirectRules);

  // Сохраняем файл
  fs.writeFileSync(configPath, lines.join('\n'), 'utf8');

  // Перезагружаем конфиг в Mihomo
  await makeMihomoRequest('PUT', '/configs', { path: configPath });
  return true;
}

// Периодическое сохранение БД трафика каждые 5 минут
setInterval(saveTrafficDb, 5 * 60 * 1000);

// Обработчики завершения процесса для сохранения перед выходом
let isSavingOnExit = false;
function handleExitSave(signal) {
  if (isSavingOnExit) return;
  isSavingOnExit = true;
  console.log(`Получен сигнал ${signal}. Сохраняем БД трафика...`);
  saveTrafficDbSync();
  process.exit(0);
}

process.on('SIGINT', () => handleExitSave('SIGINT'));
process.on('SIGTERM', () => handleExitSave('SIGTERM'));
process.on('exit', () => {
  saveTrafficDbSync();
});

module.exports = {
  getClientsList,
  toggleClientVpn,
  renameClient,
  setClientGroupPreference,
  disableVpnForAllClients,
  saveTrafficDb,
  saveTrafficDbSync
};
