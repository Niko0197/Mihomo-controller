// clients_manager.js
// Модуль для обнаружения клиентов, ведения базы имен, подсчета трафика и переключения правил VPN

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { execSync } = require('child_process');

function getActiveConfigPath() {
  if (fs.existsSync('/opt/etc/mihomo/config.yaml')) {
    return '/opt/etc/mihomo/config.yaml';
  }
  if (fs.existsSync('\\\\Netcraze-9884\\opkg\\etc\\mihomo\\config.yaml')) {
    return '\\\\Netcraze-9884\\opkg\\etc\\mihomo\\config.yaml';
  }
  return path.join(__dirname, 'config.yaml');
}

function getClientsRulesPath() {
  const activeCfg = getActiveConfigPath();
  return path.join(path.dirname(activeCfg), 'clients_rules.yaml');
}

const dbPath = path.join(__dirname, 'clients_db.json');

const API_HOST = process.env.MIHOMO_API_HOST || '127.0.0.1';
const API_PORT = parseInt(process.env.MIHOMO_API_PORT, 10) || 9090;

function getRouterIps() {
  const ips = new Set(['127.0.0.1', '::1', '0.0.0.0', 'localhost', '192.168.1.1']);
  try {
    const interfaces = os.networkInterfaces();
    for (const name in interfaces) {
      for (const net of interfaces[name]) {
        if (net && net.address) {
          ips.add(net.address);
        }
      }
    }
  } catch (e) {}
  return ips;
}

function isRouterOrLoopback(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0' || ip === 'localhost') return true;
  if (ip.startsWith('127.')) return true;
  const routerIps = getRouterIps();
  return routerIps.has(ip);
}

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
  if (!entry) return { name: '', group: '', zapretMode: 'default' };
  if (typeof entry === 'string') {
    return { name: entry, group: '', zapretMode: 'default' };
  }
  return {
    name: entry.name || '',
    group: entry.group || '',
    zapretMode: entry.zapretMode || 'default'
  };
}

function setClientName(key, name) {
  if (!clientsDb[key]) {
    clientsDb[key] = { name: '', group: '', zapretMode: 'default' };
  } else if (typeof clientsDb[key] === 'string') {
    clientsDb[key] = { name: clientsDb[key], group: '', zapretMode: 'default' };
  }
  clientsDb[key].name = name.trim();
  if (!clientsDb[key].name && !clientsDb[key].group && clientsDb[key].zapretMode === 'default') {
    delete clientsDb[key];
  }
}

function setClientGroup(key, group) {
  if (!clientsDb[key]) {
    clientsDb[key] = { name: '', group: '', zapretMode: 'default' };
  } else if (typeof clientsDb[key] === 'string') {
    clientsDb[key] = { name: clientsDb[key], group: '', zapretMode: 'default' };
  }
  clientsDb[key].group = group.trim();
  if (!clientsDb[key].name && !clientsDb[key].group && clientsDb[key].zapretMode === 'default') {
    delete clientsDb[key];
  }
}

function setClientZapret(key, mode) {
  if (!clientsDb[key]) {
    clientsDb[key] = { name: '', group: '', zapretMode: 'default' };
  } else if (typeof clientsDb[key] === 'string') {
    clientsDb[key] = { name: clientsDb[key], group: '', zapretMode: 'default' };
  }
  clientsDb[key].zapretMode = mode;
  if (!clientsDb[key].name && !clientsDb[key].group && clientsDb[key].zapretMode === 'default') {
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

// Функция чтения файла clients_rules.yaml
function readClientsRulesText() {
  const cRulesPath = getClientsRulesPath();
  const cPath = getActiveConfigPath();

  if (fs.existsSync(cRulesPath)) {
    return fs.readFileSync(cRulesPath, 'utf8');
  }
  if (fs.existsSync(cPath)) {
    const configText = fs.readFileSync(cPath, 'utf8');
    const lines = configText.split(/\r?\n/);
    const extractBlock = (startMarker, endMarker) => {
      const s = lines.findIndex(l => l.trim() === startMarker);
      const e = lines.findIndex(l => l.trim() === endMarker);
      if (s !== -1 && e !== -1 && e >= s) {
        return lines.slice(s, e + 1).map(l => l.trim());
      }
      return [startMarker, endMarker];
    };
    const bypass = extractBlock('# --- CLIENTS BYPASS RULES ---', '# --- END CLIENTS BYPASS RULES ---');
    const zapret = extractBlock('# --- CLIENTS ZAPRET RULES ---', '# --- END CLIENTS ZAPRET RULES ---');
    const vpn = extractBlock('# --- CLIENTS VPN RULES ---', '# --- END CLIENTS VPN RULES ---');

    const defaultContent = [
      '# ============================================================',
      '#   Mihomo Controller — Правила маршрутизации устройств (Clients)',
      '# ============================================================',
      '',
      ...bypass,
      '',
      ...zapret,
      '',
      ...vpn,
      ''
    ].join('\n');

    try {
      fs.writeFileSync(cRulesPath, defaultContent, 'utf8');
    } catch (e) {}
    return defaultContent;
  }
  return '';
}

function getMihomoRulesDir() {
  return path.join(path.dirname(getActiveConfigPath()), 'rules');
}

function ensureRuleFile(filename, items) {
  const mihomoRulesDir = getMihomoRulesDir();
  if (!fs.existsSync(mihomoRulesDir)) {
    try { fs.mkdirSync(mihomoRulesDir, { recursive: true }); } catch (e) {}
  }
  const filePath = path.join(mihomoRulesDir, filename);
  let content = 'payload:';
  if (!items || items.length === 0) {
    content += ' []\n';
  } else {
    content += '\n' + items.map(ip => `  - SRC-IP-CIDR,${ip}/32`).join('\n') + '\n';
  }
  try {
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (e) {}
}

// Вспомогательная функция для вставки/замены блока правил в текст конфига
function updateConfigRulesBlock(lines, startMarker, endMarker, newRuleLines, insertBeforeKeyword) {
  let startIdx = lines.findIndex(l => l.trim() === startMarker);
  let endIdx = lines.findIndex(l => l.trim() === endMarker);

  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    lines.splice(startIdx + 1, endIdx - startIdx - 1, ...newRuleLines);
  } else {
    // Если маркеров нет, находим подходящее место в секции rules:
    let rulesIdx = lines.findIndex(l => l.trim() === 'rules:');
    let insertAt = -1;

    if (insertBeforeKeyword) {
      insertAt = lines.findIndex(l => l.trim().includes(insertBeforeKeyword));
    }
    if (insertAt === -1 && rulesIdx !== -1) {
      insertAt = rulesIdx + 1;
    }
    if (insertAt === -1) {
      insertAt = lines.length;
    }

    const blockToInsert = [`  ${startMarker}`, ...newRuleLines, `  ${endMarker}`];
    lines.splice(insertAt, 0, ...blockToInsert);
  }
}

// Синхронизирует правила из clients_rules.yaml напрямую в config.yaml и rule-providers
function syncClientsRulesToConfig() {
  const clientsRulesText = readClientsRulesText();
  const crLines = clientsRulesText.split(/\r?\n/);

  const bypassRules = [];
  const zapretRules = [];
  const vpnRules = [];

  const bypassIps = [];
  const zapretNfqws1Ips = [];
  const zapretNfqws2Ips = [];
  const vpnManual1Ips = [];
  const vpnManual2Ips = [];
  const vpnManual3Ips = [];
  const vpnAutobestIps = [];

  let currentBlock = '';
  for (const line of crLines) {
    const trimmed = line.trim();
    if (trimmed === '# --- CLIENTS BYPASS RULES ---') { currentBlock = 'bypass'; continue; }
    if (trimmed === '# --- END CLIENTS BYPASS RULES ---') { currentBlock = ''; continue; }
    if (trimmed === '# --- CLIENTS ZAPRET RULES ---') { currentBlock = 'zapret'; continue; }
    if (trimmed === '# --- END CLIENTS ZAPRET RULES ---') { currentBlock = ''; continue; }
    if (trimmed === '# --- CLIENTS VPN RULES ---') { currentBlock = 'vpn'; continue; }
    if (trimmed === '# --- END CLIENTS VPN RULES ---') { currentBlock = ''; continue; }

    if (currentBlock === 'bypass' && trimmed.startsWith('-')) {
      bypassRules.push('  ' + trimmed);
      if (trimmed.startsWith('- SRC-IP-CIDR,')) {
        const ip = trimmed.split(',')[1].split('/')[0].trim();
        if (ip && !bypassIps.includes(ip)) bypassIps.push(ip);
      }
    } else if (currentBlock === 'zapret' && trimmed.startsWith('-')) {
      zapretRules.push('  ' + trimmed);
      const match = trimmed.match(/SRC-IP-CIDR,([^,/]+)/);
      if (match) {
        const ip = match[1].trim();
        if (trimmed.includes('ByeDPI 1') || trimmed.includes('NFQWS 1')) {
          if (!zapretNfqws1Ips.includes(ip)) zapretNfqws1Ips.push(ip);
        } else if (trimmed.includes('ByeDPI 2') || trimmed.includes('NFQWS 2')) {
          if (!zapretNfqws2Ips.includes(ip)) zapretNfqws2Ips.push(ip);
        }
      }
    } else if (currentBlock === 'vpn' && trimmed.startsWith('-')) {
      vpnRules.push('  ' + trimmed);
      if (trimmed.startsWith('- SRC-IP-CIDR,')) {
        const parts = trimmed.split(',');
        const ip = parts[1].split('/')[0].trim();
        const group = parts[2] ? parts[2].trim() : '';
        if (group.includes('Manual 1')) { if (!vpnManual1Ips.includes(ip)) vpnManual1Ips.push(ip); }
        else if (group.includes('Manual 2')) { if (!vpnManual2Ips.includes(ip)) vpnManual2Ips.push(ip); }
        else if (group.includes('Manual 3')) { if (!vpnManual3Ips.includes(ip)) vpnManual3Ips.push(ip); }
        else if (group.includes('Auto-Best') || !group) { if (!vpnAutobestIps.includes(ip)) vpnAutobestIps.push(ip); }
      }
    }
  }

  // Обновляем файлы в rule-providers (для совместимости)
  ensureRuleFile('clients_bypass.yaml', bypassIps);
  ensureRuleFile('clients_zapret_nfqws1.yaml', zapretNfqws1Ips);
  ensureRuleFile('clients_zapret_nfqws2.yaml', zapretNfqws2Ips);
  ensureRuleFile('clients_vpn_manual1.yaml', vpnManual1Ips);
  ensureRuleFile('clients_vpn_manual2.yaml', vpnManual2Ips);
  ensureRuleFile('clients_vpn_manual3.yaml', vpnManual3Ips);
  ensureRuleFile('clients_vpn_autobest.yaml', vpnAutobestIps);

  // Обновляем активный config.yaml Mihomo
  const activeCfg = getActiveConfigPath();
  if (fs.existsSync(activeCfg)) {
    try {
      const configText = fs.readFileSync(activeCfg, 'utf8');
      const lines = configText.split(/\r?\n/);

      updateConfigRulesBlock(lines, '# --- CLIENTS BYPASS RULES ---', '# --- END CLIENTS BYPASS RULES ---', bypassRules, '# --- DYNAMIC RULES ---');
      updateConfigRulesBlock(lines, '# --- CLIENTS ZAPRET RULES ---', '# --- END CLIENTS ZAPRET RULES ---', zapretRules, 'RULE-SET,youtube@domain');
      updateConfigRulesBlock(lines, '# --- CLIENTS VPN RULES ---', '# --- END CLIENTS VPN RULES ---', vpnRules, 'MATCH,');

      fs.writeFileSync(activeCfg, lines.join('\n'), 'utf8');
    } catch (err) {
      console.error('Ошибка записи правил клиентов в активный config.yaml:', err.message);
    }
  }

  // Также обновляем локальный config.yaml (если запуск на роутере и есть копия в репозитории)
  const localCfg = path.join(__dirname, 'config.yaml');
  if (activeCfg !== localCfg && fs.existsSync(localCfg)) {
    try {
      const localText = fs.readFileSync(localCfg, 'utf8');
      const localLines = localText.split(/\r?\n/);

      updateConfigRulesBlock(localLines, '# --- CLIENTS BYPASS RULES ---', '# --- END CLIENTS BYPASS RULES ---', bypassRules, '# --- DYNAMIC RULES ---');
      updateConfigRulesBlock(localLines, '# --- CLIENTS ZAPRET RULES ---', '# --- END CLIENTS ZAPRET RULES ---', zapretRules, 'RULE-SET,youtube@domain');
      updateConfigRulesBlock(localLines, '# --- CLIENTS VPN RULES ---', '# --- END CLIENTS VPN RULES ---', vpnRules, 'MATCH,');

      fs.writeFileSync(localCfg, localLines.join('\n'), 'utf8');
    } catch (err) {}
  }

  return true;
}

// Считывание текущих правил назначения прокси-групп по клиентам из clients_rules.yaml
function getClientRulesFromConfig() {
  const rules = new Map(); // IP => groupName
  try {
    const yamlText = readClientsRulesText();
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
    console.error('Ошибка чтения правил клиентов из clients_rules.yaml:', err.message);
  }
  return rules;
}

async function closeConnectionsForIp(targetIp) {
  try {
    const res = await makeMihomoRequest('GET', '/connections');
    if (res.statusCode !== 200) return;
    const data = JSON.parse(res.data);
    const connections = data.connections || [];
    const targetConns = connections.filter(c => c.metadata && (c.metadata.sourceIP === targetIp || c.metadata.sourceIP === `::ffff:${targetIp}`));
    if (targetConns.length > 0) {
      await Promise.all(targetConns.map(conn => makeMihomoRequest('DELETE', `/connections/${conn.id}`).catch(() => {})));
    }
  } catch (err) {
    console.error(`Ошибка точечного разрыва сокетов для ${targetIp}:`, err.message);
  }
}

async function setClientRulesInConfig(ipsInput, targetGroup) {
  const ips = Array.isArray(ipsInput) ? ipsInput : [ipsInput];
  if (ips.length === 0) return false;
  if (!targetGroup) throw new Error('Группа не указана');

  let yamlText = readClientsRulesText();
  let lines = yamlText.split(/\r?\n/);
  
  const findIndices = () => ({
    startBypassIdx: lines.findIndex(l => l.trim() === '# --- CLIENTS BYPASS RULES ---'),
    endBypassIdx: lines.findIndex(l => l.trim() === '# --- END CLIENTS BYPASS RULES ---'),
    startVpnIdx: lines.findIndex(l => l.trim() === '# --- CLIENTS VPN RULES ---'),
    endVpnIdx: lines.findIndex(l => l.trim() === '# --- END CLIENTS VPN RULES ---')
  });

  let { startBypassIdx, endBypassIdx, startVpnIdx, endVpnIdx } = findIndices();

  if (startBypassIdx === -1 || endBypassIdx === -1) {
    lines.unshift('# --- CLIENTS BYPASS RULES ---', '# --- END CLIENTS BYPASS RULES ---', '');
    const idxs = findIndices();
    startBypassIdx = idxs.startBypassIdx;
    endBypassIdx = idxs.endBypassIdx;
  }

  if (startVpnIdx === -1 || endVpnIdx === -1) {
    lines.push('', '# --- CLIENTS VPN RULES ---', '# --- END CLIENTS VPN RULES ---');
    const idxs = findIndices();
    startVpnIdx = idxs.startVpnIdx;
    endVpnIdx = idxs.endVpnIdx;
  }

  const isDirect = targetGroup.toLowerCase() === 'direct';

  for (const targetIp of ips) {
    const isIpv6 = targetIp.includes(':');
    const mask = isIpv6 ? '/128' : '/32';
    
    // Удаляем все старые правила для данного IP
    lines = lines.filter(l => !(l.trim().startsWith(`- SRC-IP-CIDR,${targetIp}/32,`) || l.trim().startsWith(`- SRC-IP-CIDR,${targetIp}/128,`)));
    
    if (isIpv6) continue;

    let { startBypassIdx: sb, endBypassIdx: eb, startVpnIdx: sv, endVpnIdx: ev } = findIndices();
    const newRule = `- SRC-IP-CIDR,${targetIp}${mask},${targetGroup}`;

    if (isDirect) {
      if (eb !== -1) lines.splice(eb, 0, newRule);
      else if (sb !== -1) lines.splice(sb + 1, 0, newRule);
    } else {
      if (ev !== -1) lines.splice(ev, 0, newRule);
      else if (sv !== -1) lines.splice(sv + 1, 0, newRule);
    }
  }

  fs.writeFileSync(getClientsRulesPath(), lines.join('\n'), 'utf8');

  // Синхронизируем провайдеры и перезагружаем ядро Mihomo
  syncClientsRulesToConfig();
  await makeMihomoRequest('PUT', '/configs', { path: getActiveConfigPath() }).catch(() => {});

  // Отсекаем сокеты целевого устройства
  for (const targetIp of ips) {
    await closeConnectionsForIp(targetIp);
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

  await setClientRulesInConfig(ips, group);
  return true;
}

// Установка правил Запрета для клиента в clients_rules.yaml
async function setClientZapretRulesInConfig(ipsInput, mode) {
  const ips = Array.isArray(ipsInput) ? ipsInput : [ipsInput];
  if (ips.length === 0) return false;

  let yamlText = readClientsRulesText();
  let lines = yamlText.split(/\r?\n/);

  const findIndices = () => ({
    startZapretIdx: lines.findIndex(l => l.trim() === '# --- CLIENTS ZAPRET RULES ---'),
    endZapretIdx: lines.findIndex(l => l.trim() === '# --- END CLIENTS ZAPRET RULES ---')
  });

  let { startZapretIdx, endZapretIdx } = findIndices();

  if (startZapretIdx === -1 || endZapretIdx === -1) {
    lines.push('', '# --- CLIENTS ZAPRET RULES ---', '# --- END CLIENTS ZAPRET RULES ---');
    const idxs = findIndices();
    startZapretIdx = idxs.startZapretIdx;
    endZapretIdx = idxs.endZapretIdx;
  }

  for (const targetIp of ips) {
    if (targetIp.includes(':')) continue;

    // Удаляем предыдущие zapret правила для этого IP
    lines = lines.filter(l => !(l.includes(`SRC-IP-CIDR,${targetIp}/32`) && l.includes('RULE-SET,youtube@domain')));

    let { startZapretIdx: sz, endZapretIdx: ez } = findIndices();

    if (mode === 'nfqws1' || mode === 'byedpi1') {
      const newRule = `- AND,((SRC-IP-CIDR,${targetIp}/32),(RULE-SET,youtube@domain)),⚡ ByeDPI 1 (ТВ)`;
      if (ez !== -1) lines.splice(ez, 0, newRule);
      else if (sz !== -1) lines.splice(sz + 1, 0, newRule);
    } else if (mode === 'nfqws2' || mode === 'byedpi2') {
      const newRule = `- AND,((SRC-IP-CIDR,${targetIp}/32),(RULE-SET,youtube@domain)),⚡ ByeDPI 2 (Смартфон/ПК)`;
      if (ez !== -1) lines.splice(ez, 0, newRule);
      else if (sz !== -1) lines.splice(sz + 1, 0, newRule);
    }
  }

  fs.writeFileSync(getClientsRulesPath(), lines.join('\n'), 'utf8');

  syncClientsRulesToConfig();
  await makeMihomoRequest('PUT', '/configs', { path: getActiveConfigPath() }).catch(() => {});

  for (const targetIp of ips) {
    await closeConnectionsForIp(targetIp);
  }

  return true;
}

// Установка/сохранение предпочтительной стратегии Запрета клиента
async function setClientZapretPreference(ip, mode) {
  if (!ip) throw new Error('IP адрес не указан');
  const validModes = ['default', 'nfqws1', 'nfqws2'];
  const targetMode = validModes.includes(mode) ? mode : 'default';
  
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
    console.error('Ошибка при определении MAC для смены Запрета:', e.message);
  }

  setClientZapret(ip, targetMode);
  if (mac) {
    setClientZapret(mac, targetMode);
  }
  for (const altIp of ips) {
    setClientZapret(altIp, targetMode);
  }
  saveDb();

  await setClientZapretRulesInConfig(ips, targetMode);
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
      timeout: 20000
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
        if (!ip || isRouterOrLoopback(ip)) return;

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
    const normMac = mac ? mac.toUpperCase() : '';
    const zapretMode = getClientData(normMac).zapretMode || getClientData(ip).zapretMode || 'default';
    
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
      zapretMode,
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

        if (ip && !isRouterOrLoopback(ip)) {
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
    if (h.ip && !isRouterOrLoopback(h.ip)) {
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
    if (!clientsMap.has(ip) && !isRouterOrLoopback(ip)) {
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
// Отключение VPN для всех клиентов (перевод в DIRECT)
async function disableVpnForAllClients() {
  let yamlText = readClientsRulesText();
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

  if (vpnRules.length === 0) return false;

  // Удаляем их из блока VPN
  lines.splice(startVpnIdx + 1, endVpnIdx - startVpnIdx - 1);
  
  // Пересчитываем индексы
  startBypassIdx = lines.findIndex(l => l.trim() === '# --- CLIENTS BYPASS RULES ---');
  endBypassIdx = lines.findIndex(l => l.trim() === '# --- END CLIENTS BYPASS RULES ---');

  // Преобразуем правила в DIRECT и добавляем в Bypass блок
  const directRules = vpnRules.map(r => {
    const parts = r.split(',');
    parts[2] = 'DIRECT';
    return parts.join(',');
  });

  const existingBypassRules = lines.slice(startBypassIdx + 1, endBypassIdx);
  const newDirectRules = directRules.filter(newRule => {
    const newIp = newRule.split(',')[1];
    return !existingBypassRules.some(extRule => extRule.split(',')[1] === newIp);
  });

  lines.splice(endBypassIdx, 0, ...newDirectRules);

  fs.writeFileSync(getClientsRulesPath(), lines.join('\n'), 'utf8');
  syncClientsRulesToConfig();

  await makeMihomoRequest('PUT', '/configs', { path: getActiveConfigPath() });
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
  setClientZapretPreference,
  setClientRulesInConfig,
  setClientZapretRulesInConfig,
  disableVpnForAllClients,
  syncClientsRulesToConfig,
  saveTrafficDb,
  saveTrafficDbSync
};
