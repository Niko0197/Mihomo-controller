const http = require('http');
const https = require('https');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const yamlUtils = require('./yaml_utils');
const systemStats = require('./system_stats');
const clientsManager = require('./clients_manager');

const PORT = 4000;
const API_PORT = 9090;
const API_HOST = '192.168.1.1';
const configPath = '/opt/etc/mihomo/config.yaml';
const logRuPath = path.join(__dirname, 'log_ru.txt');
// Автоматическая ротация текстовых логов (защита флеш-памяти роутера, макс 500 КБ)
function rotateLogFile(filePath, maxBytes = 500 * 1024) {
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.size > maxBytes) {
        const content = fs.readFileSync(filePath, 'utf8');
        const trimmed = content.slice(-200 * 1024);
        const firstNewline = trimmed.indexOf('\n');
        const cleanText = firstNewline !== -1 ? trimmed.slice(firstNewline + 1) : trimmed;
        fs.writeFileSync(filePath, `--- [Ротация лога: ${new Date().toLocaleString('ru-RU')}] ---\n` + cleanText, 'utf8');
      }
    }
  } catch (e) {
    console.error('Ошибка ротации лога:', e.message);
  }
}

function autoRotateAllLogs() {
  const logs = [
    path.join(__dirname, 'log.txt'),
    path.join(__dirname, 'log_ru.txt'),
    path.join(__dirname, 'server_out.log'),
    path.join(__dirname, 'server_err.log')
  ];
  logs.forEach(l => rotateLogFile(l));
}

autoRotateAllLogs();
setInterval(autoRotateAllLogs, 30 * 60 * 1000);

// Автоматический сбор мусора V8 каждые 10 минут
setInterval(() => {
  if (global.gc) {
    try { global.gc(); } catch (e) {}
  }
}, 10 * 60 * 1000);

// Вспомогательная функция для выполнения HTTP-запросов к API Mihomo
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
      timeout: 60000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });

    req.on('error', reject);
    req.on('timeout', () => { 
      req.destroy(); 
      reject(new Error('Mihomo API timeout')); 
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Функция для парсинга групп из GLOBAL секции config.yaml
function getGlobalGroupsFromConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const yamlText = fs.readFileSync(configPath, 'utf8');
      const lines = yamlText.split(/\r?\n/);
      let inGlobal = false;
      let inProxies = false;
      const foundGroups = [];
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        
        if (inGlobal && trimmed.startsWith('- name:') && !trimmed.includes('GLOBAL')) {
          break;
        }
        
        if (trimmed.replace(/['"]/g, '') === '- name: GLOBAL') {
          inGlobal = true;
          continue;
        }
        
        if (inGlobal) {
          if (trimmed.startsWith('proxies:')) {
            inProxies = true;
            continue;
          }
          if (inProxies) {
            if (trimmed.startsWith('-')) {
              const groupName = trimmed.substring(1).trim().replace(/^['"]|['"]$/g, '');
              if (groupName && groupName !== 'GLOBAL') {
                foundGroups.push(groupName);
              }
            } else if (trimmed.includes(':') && !trimmed.startsWith('-')) {
              inProxies = false;
            }
          }
        }
      }
      
      if (foundGroups.length > 0) {
        if (!foundGroups.includes('DIRECT')) foundGroups.push('DIRECT');
        if (!foundGroups.includes('REJECT')) foundGroups.push('REJECT');
        return foundGroups;
      }
    }
  } catch (err) {
    console.error('Ошибка парсинга config.yaml для получения GLOBAL групп:', err.message);
  }
  return null;
}

// Функция для получения абсолютно всех групп из config.yaml (включая группы сервисов)
function getAllGroupsFromConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const yamlText = fs.readFileSync(configPath, 'utf8');
      const lines = yamlText.split(/\r?\n/);
      let inProxyGroups = false;
      const foundGroups = [];
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        
        if (line.startsWith('proxy-groups:')) {
          inProxyGroups = true;
          continue;
        }
        if (inProxyGroups && (line.startsWith('rules:') || line.startsWith('rule-providers:') || (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')))) {
          inProxyGroups = false;
          continue;
        }
        
        if (inProxyGroups && trimmed.startsWith('- name:')) {
          const name = trimmed.substring(trimmed.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '');
          if (name && name !== 'GLOBAL') {
            foundGroups.push(name);
          }
        }
      }
      return foundGroups;
    }
  } catch (err) {
    console.error('Ошибка парсинга config.yaml для получения всех групп:', err.message);
  }
  return [];
}

// Вспомогательная функция для скачивания файлов
function downloadHttpsFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error('HTTP статус ' + res.statusCode + ' для ' + url));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Принудительное обновление Tor мостов с GitHub
async function updateTorBridgesDirectly() {
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
      console.error('Ошибка принудительного скачивания мостов ' + key + ': ' + err.message);
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
  
  fs.writeFileSync(torJsonPath, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

// === ОТДАЧА СТАТИЧЕСКИХ ФАЙЛОВ ===
function serveStaticFile(res, fileName, contentType) {
  const filePath = path.join(__dirname, 'public', fileName);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.error('Ошибка отдачи статического файла ' + filePath + ':', err.message);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(data);
  });
}

function getGeoIp(ip) {
  return new Promise((resolve) => {
    const req = https.get('https://freeipapi.com/api/json/' + ip, { timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.countryCode || null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

// GET /api/xkeen/traffic (NDJSON stream)
function handleXkeenTraffic(req, res) {
  const options = {
    hostname: API_HOST,
    port: API_PORT,
    path: '/traffic',
    method: 'GET'
  };
  
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    proxyRes.pipe(res);
  });
  
  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Сбой связи с API Mihomo (traffic): ' + err.message);
  });
  
  req.on('close', () => {
    proxyReq.destroy();
  });
  
  proxyReq.end();
}

// GET /api/xkeen/logs (NDJSON stream)
function handleXkeenLogs(req, res) {
  const urlObj = new URL(req.url, 'http://' + req.headers.host);
  const level = urlObj.searchParams.get('level') || 'info';
  
  const options = {
    hostname: API_HOST,
    port: API_PORT,
    path: '/logs?level=' + encodeURIComponent(level),
    method: 'GET'
  };
  
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    proxyRes.pipe(res);
  });
  
  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Сбой связи с API Mihomo (logs): ' + err.message);
  });
  
  req.on('close', () => {
    proxyReq.destroy();
  });
  
  proxyReq.end();
}

// GET /api/xkeen/connections
async function handleXkeenConnections(req, res) {
  try {
    const mRes = await makeMihomoRequest('GET', '/connections');
    res.writeHead(mRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(mRes.data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// DELETE /api/xkeen/connections/:id
async function handleCloseConnection(req, res, id) {
  try {
    const mRes = await makeMihomoRequest('DELETE', '/connections/' + encodeURIComponent(id));
    res.writeHead(mRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(mRes.data || JSON.stringify({ success: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// GET /api/xkeen/trace?domain=...
async function handleXkeenTrace(req, res) {
  try {
    const urlObj = new URL(req.url, 'http://' + req.headers.host);
    const domain = urlObj.searchParams.get('domain');
    if (!domain) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Параметр domain обязателен' }));
      return;
    }

    let trimmedDomain = domain.trim().toLowerCase();
    // Очищаем домен от протокола, путей, порта и GET-параметров
    trimmedDomain = trimmedDomain.replace(/^(https?:\/\/)?(www\.)?/, '');
    trimmedDomain = trimmedDomain.split('/')[0].split(':')[0];
    
    // 1. DNS Resolution
    let ips = [];
    try {
      const dns = require('dns').promises;
      const lookupResult = await dns.lookup(trimmedDomain, { all: true });
      ips = lookupResult.map(r => r.address);
    } catch (dnsErr) {
      console.warn('DNS lookup failed for ' + trimmedDomain + ':', dnsErr.message);
    }

    // 2. GeoIP check on the first resolved IPv4
    let countryCode = null;
    const ipv4 = ips.find(ip => !ip.includes(':'));
    if (ipv4) {
      countryCode = await getGeoIp(ipv4);
    }

    // 3. Load rules from config.yaml
    const rulesList = [];
    if (fs.existsSync(configPath)) {
      try {
        const yamlText = fs.readFileSync(configPath, 'utf8');
        const lines = yamlText.split(/\r?\n/);
        let inRules = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line === 'rules:') {
            inRules = true;
            continue;
          }
          if (inRules) {
            if (line.startsWith('-')) {
              const ruleContent = line.substring(1).trim().replace(/^['"]|['"]$/g, '');
              if (ruleContent) rulesList.push(ruleContent);
            } else if (line !== '' && !line.startsWith('#') && !lines[i].startsWith(' ') && !lines[i].startsWith('\t')) {
              inRules = false;
            }
          }
        }
      } catch (err) {
        console.error('Ошибка чтения правил из config.yaml:', err.message);
      }
    }

    // 4. Simulate rule matching
    const steps = [];
    let matchedRule = null;
    let matchedPolicy = null;

    function ipInCidr(ip, cidr) {
      try {
        const [range, bits] = cidr.split('/');
        const mask = ~( (1 << (32 - bits)) - 1 );
        
        const ipParts = ip.split('.').map(Number);
        const rangeParts = range.split('.').map(Number);
        
        if (ipParts.length !== 4 || rangeParts.length !== 4) return false;
        
        const ipNum = (ipParts[0] << 24) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3];
        const rangeNum = (rangeParts[0] << 24) + (rangeParts[1] << 16) + (rangeParts[2] << 8) + rangeParts[3];
        
        return (ipNum & mask) === (rangeNum & mask);
      } catch (e) {
        return false;
      }
    }

    function matchesRuleSet(d, providerName) {
      const name = providerName.split('@')[0].toLowerCase();
      
      if (name.startsWith('custom') || name === 'smart_unblock') {
        try {
          const filesToCheck = [];
          if (name === 'smart_unblock') {
            filesToCheck.push('/opt/etc/mihomo/smart_unblock.yaml');
          } else if (name === 'custom') {
            filesToCheck.push('/opt/etc/mihomo/rules/custom.yaml');
          } else {
            filesToCheck.push(`/opt/etc/mihomo/rules/${name}.yaml`);
          }
          for (const p of filesToCheck) {
            if (fs.existsSync(p)) {
              const text = fs.readFileSync(p, 'utf8');
              if (text.toLowerCase().includes(d.toLowerCase())) {
                return true;
              }
            }
          }
        } catch (e) {}
        if (name === 'custom') return false;
      }
      
      if (name === 'youtube' && (d.includes('youtube') || d.includes('youtu.be') || d.includes('ytimg') || d.includes('ggpht'))) return true;
      if (name === 'google' && (d.includes('google') || d.includes('gstatic') || d.includes('googleapis') || d.includes('ggpht') || d.includes('doubleclick'))) return true;
      if (name === 'twitter' && (d.includes('twitter') || d.includes('x.com') || d.includes('t.co') || d.includes('twimg'))) return true;
      if (name === 'apple' && (d.includes('apple') || d.includes('icloud') || d.includes('mzstatic') || d.includes('itunes'))) return true;
      if (name === 'telegram' && (d.includes('telegram') || d.includes('t.me') || d.includes('tdesktop'))) return true;
      if (name === 'discord' && (d.includes('discord') || d.includes('discordapp') || d.includes('discordstatus'))) return true;
      
      if (d.includes(name)) return true;
      return false;
    }

    function evaluateCompositeRule(type, ruleContent, d, country, ip) {
      let inner = ruleContent.trim();
      if (inner.startsWith('(') && inner.endsWith(')')) {
        inner = inner.substring(1, inner.length - 1);
      }
      
      const subRules = [];
      let bracketCount = 0;
      let currentSub = '';
      for (let i = 0; i < inner.length; i++) {
        const char = inner[i];
        if (char === '(') {
          bracketCount++;
          if (bracketCount > 1) currentSub += char;
        } else if (char === ')') {
          bracketCount--;
          if (bracketCount > 0) {
            currentSub += char;
          } else {
            subRules.push(currentSub);
            currentSub = '';
          }
        } else {
          if (bracketCount > 0) {
            currentSub += char;
          }
        }
      }
      
      const results = subRules.map(subRuleStr => {
        const parts = subRuleStr.split(',');
        const sType = parts[0].trim().toUpperCase();
        const sPayload = parts[1] ? parts[1].trim() : '';
        
        if (sType === 'DOMAIN') {
          return d === sPayload.toLowerCase();
        }
        if (sType === 'DOMAIN-SUFFIX') {
          return d === sPayload.toLowerCase() || d.endsWith('.' + sPayload.toLowerCase());
        }
        if (sType === 'DOMAIN-KEYWORD') {
          return d.includes(sPayload.toLowerCase());
        }
        if (sType === 'RULE-SET') {
          return matchesRuleSet(d, sPayload);
        }
        if (sType === 'GEOIP') {
          return country && country === sPayload.toUpperCase();
        }
        if (sType === 'IP-CIDR' || sType === 'IP-CIDR6') {
          return ip && ipInCidr(ip, sPayload);
        }
        if (sType === 'OR' || sType === 'AND') {
          return evaluateCompositeRule(sType, sPayload, d, country, ip);
        }
        return false;
      });
      
      if (type === 'OR') {
        return results.some(r => r === true);
      }
      if (type === 'AND') {
        return results.length > 0 && results.every(r => r === true);
      }
      return false;
    }

    for (const rule of rulesList) {
      let type = '';
      let payload = '';
      let policy = '';
      
      if (rule.startsWith('OR,') || rule.startsWith('AND,') || rule.startsWith('NOT,')) {
        type = rule.startsWith('OR,') ? 'OR' : (rule.startsWith('AND,') ? 'AND' : 'NOT');
        const lastCloseParen = rule.lastIndexOf(')');
        payload = rule.substring(type.length + 1, lastCloseParen + 1);
        policy = rule.substring(lastCloseParen + 2).trim();
      } else {
        const parts = rule.split(',').map(p => p.trim());
        type = parts[0].toUpperCase();
        if (parts.length === 2) {
          payload = '';
          policy = parts[1] || '';
        } else {
          payload = parts[1] || '';
          policy = parts[2] || '';
        }
      }
      
      let matched = false;
      let reason = '';

      if (type === 'OR' || type === 'AND') {
        matched = evaluateCompositeRule(type, payload, trimmedDomain, countryCode, ipv4);
        reason = matched ? 'Сработало составное правило (' + type + ')' : 'Составное правило (' + type + ') не сработало';
      } else if (type === 'DOMAIN') {
        matched = (trimmedDomain === payload.toLowerCase());
        reason = matched ? 'Точное совпадение домена' : 'Домен не совпадает';
      } else if (type === 'DOMAIN-SUFFIX') {
        matched = (trimmedDomain === payload.toLowerCase() || trimmedDomain.endsWith('.' + payload.toLowerCase()));
        reason = matched ? 'Домен оканчивается на .' + payload : 'Суффикс не совпадает';
      } else if (type === 'DOMAIN-KEYWORD') {
        matched = trimmedDomain.includes(payload.toLowerCase());
        reason = matched ? 'Домен содержит ключевое слово: ' + payload : 'Ключевое слово отсутствует';
      } else if (type === 'RULE-SET') {
        matched = matchesRuleSet(trimmedDomain, payload);
        reason = matched ? 'Правило найдено в наборе правил ' + payload : 'Не входит в набор правил ' + payload;
      } else if (type === 'GEOIP') {
        if (countryCode) {
          matched = (countryCode === payload.toUpperCase());
          reason = matched ? 'IP адрес принадлежит стране: ' + payload : 'Страна IP адреса (' + countryCode + ') не совпадает с ' + payload;
        } else {
          reason = 'Пропущено: не удалось определить страну IP адреса';
        }
      } else if (type === 'IP-CIDR' || type === 'IP-CIDR6') {
        if (ipv4 && type === 'IP-CIDR') {
          matched = ipInCidr(ipv4, payload);
          reason = matched ? 'IP адрес входит в подсеть: ' + payload : 'IP адрес не входит в подсеть: ' + payload;
        } else {
          reason = 'Пропущено: нет IPv4 адреса';
        }
      } else if (type === 'MATCH') {
        matched = true;
        reason = 'Финальное правило по умолчанию (MATCH)';
      }

      steps.push({ rule, matched, reason });

      if (matched) {
        matchedRule = rule;
        matchedPolicy = policy;
        break;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: true,
      domain: trimmedDomain,
      ips,
      country: countryCode,
      matchedRule,
      matchedPolicy,
      steps
    }));

  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// === API ХЕНДЛЕРЫ ===

// GET /api/data
async function handleGetData(req, res) {
  try {
    const domains = [];
    if (fs.existsSync(logRuPath)) {
      const logsText = fs.readFileSync(logRuPath, 'utf8');
      const logLines = logsText.split(/\r?\n/);
      
      const regex = /\[(.*?)\] ВНИМАНИЕ: Домен (.*?) пошел через VPN! Цепочка: (.*?) \| Правило: (.*)/;
      
      logLines.forEach(line => {
        if (!line.trim() || line.startsWith('#')) return;
        const match = line.match(regex);
        if (match) {
          domains.push({
            timestamp: match[1],
            domain: match[2],
            chain: match[3],
            rule: match[4]
          });
        }
      });
    }

    let groups = getGlobalGroupsFromConfig() || [];
    const allGroups = getAllGroupsFromConfig();
    allGroups.forEach(g => {
      if (!groups.includes(g)) groups.push(g);
    });
    
    if (groups.length === 0) {
      groups = ['DIRECT', 'REJECT'];
      try {
        const mRes = await makeMihomoRequest('GET', '/proxies');
        if (mRes.statusCode === 200) {
          const payload = JSON.parse(mRes.data);
          const proxiesObj = payload.proxies || {};
          
          const globalKey = Object.keys(proxiesObj).find(k => k.toLowerCase() === 'global');
          if (globalKey && proxiesObj[globalKey] && Array.isArray(proxiesObj[globalKey].all)) {
            groups = proxiesObj[globalKey].all.filter(name => name.toLowerCase() !== 'global');
            if (!groups.includes('DIRECT')) groups.push('DIRECT');
            if (!groups.includes('REJECT')) groups.push('REJECT');
          } else {
            const filteredGroups = Object.keys(proxiesObj).filter(name => {
              const p = proxiesObj[name];
              return p && ['Selector', 'Fallback', 'URLTest', 'Select', 'URL-Test', 'Fallback'].includes(p.type);
            });
            filteredGroups.forEach(g => {
              if (!groups.includes(g)) groups.push(g);
            });
          }
        }
      } catch (err) {
        console.error('Ошибка связи с API Mihomo:', err.message);
      }
    }
    
    if (groups.length <= 2) {
      groups = [
        '🚀Auto-Best',
        '⚙️Manual 1',
        '⚙️Manual 2',
        '⚙️Manual 3',
        '💎 StealthSurf',
        '💎 StealthSurf 2',
        '🎱 GitHub',
        'DIRECT',
        'REJECT'
      ];
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ domains, groups }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// POST /api/apply
function handleApply(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const assignments = payload.assignments || [];

      if (assignments.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Нет выбранных доменов' }));
        return;
      }

      if (!fs.existsSync(configPath)) {
        throw new Error('Mihomo config.yaml не найден по пути ' + configPath);
      }

      const rulesDir = '/opt/etc/mihomo/rules';
      if (!fs.existsSync(rulesDir)) {
        fs.mkdirSync(rulesDir, { recursive: true });
      }

      const appliedDomains = assignments.map(a => a.domain.trim().toLowerCase());
      
      // Обрабатываем каждое назначение
      for (const item of assignments) {
        const domain = item.domain.trim().toLowerCase();
        const group = item.group.trim();
        const key = getGroupNameKey(group);
        const ruleStr = parseDomainOrIp(item.domain);

        // 1. Очищаем этот домен из всех остальных custom_*.yaml файлов для предотвращения дублирования
        if (fs.existsSync(rulesDir)) {
          const files = fs.readdirSync(rulesDir).filter(f => f.startsWith('custom_') && f.endsWith('.yaml'));
          for (const file of files) {
            const filePath = path.join(rulesDir, file);
            const fileRules = readRuleProvider(filePath);
            const filteredRules = fileRules.filter(r => {
              const parts = r.split(',');
              const pat = parts[1] ? parts[1].trim().toLowerCase() : '';
              return pat !== domain;
            });
            if (filteredRules.length !== fileRules.length) {
              writeRuleProvider(filePath, filteredRules);
            }
          }
        }

        // 2. Добавляем правило в целевой файл
        const targetPath = path.join(rulesDir, `${key}.yaml`);
        const targetRules = readRuleProvider(targetPath);
        const ruleExists = targetRules.some(r => {
          const parts = r.split(',');
          const pat = parts[1] ? parts[1].trim().toLowerCase() : '';
          return pat === domain;
        });

        if (!ruleExists) {
          targetRules.push(ruleStr);
          writeRuleProvider(targetPath, targetRules);
        }
      }

      // 3. Убеждаемся, что rule-providers и RULE-SET ссылки прописаны в config.yaml
      const keysAndNames = assignments.map(item => ({
        key: getGroupNameKey(item.group),
        group: item.group
      }));
      const uniqueKeysAndNames = [];
      const seenKeys = new Set();
      for (const item of keysAndNames) {
        if (!seenKeys.has(item.key)) {
          seenKeys.add(item.key);
          uniqueKeysAndNames.push(item);
        }
      }

      const yamlText = fs.readFileSync(configPath, 'utf8');
      const ensureRes = ensureCustomRuleProvidersInConfig(yamlText, uniqueKeysAndNames);
      if (ensureRes.changed) {
        fs.writeFileSync(configPath, ensureRes.yamlText, 'utf8');
      }

      // 4. Очищаем логи
      if (fs.existsSync(logRuPath)) {
        let logsText = fs.readFileSync(logRuPath, 'utf8');
        let logLines = logsText.split(/\r?\n/);
        
        let updatedLogLines = logLines.filter(line => {
          if (!line.trim() || line.startsWith('#')) return true;
          const match = line.match(/Домен (.*?) пошел/);
          if (match) {
            const dom = match[1].toLowerCase();
            return !appliedDomains.includes(dom);
          }
          return true;
        });
        
        fs.writeFileSync(logRuPath, updatedLogLines.join('\n'), 'utf8');
      }

      // 5. Перезагружаем конфигурацию Mihomo
      try {
        const reloadRes = await makeMihomoRequest('PUT', '/configs', { path: configPath });
        if (reloadRes.statusCode !== 200 && reloadRes.statusCode !== 204) {
          throw new Error('Mihomo API вернуло код ' + reloadRes.statusCode);
        }
      } catch (err) {
        throw new Error('Не удалось перезапустить Mihomo: ' + err.message);
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, message: 'Правила применены, Mihomo перезагружен!' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: err.message }));
    }
  });
}

// GET /api/tor-bridges
function handleGetTorBridges(req, res) {
  try {
    let data = { success: false, error: 'Файл мостов еще не создан фоновым процессом' };
    
    if (fs.existsSync(torJsonPath)) {
      const fileContent = fs.readFileSync(torJsonPath, 'utf8');
      const parsed = JSON.parse(fileContent);
      data = {
        success: true,
        lastUpdated: parsed.lastUpdated,
        bridges: parsed.bridges
      };
    }
    
    res.writeHead(200, { 
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
    });
    res.end(JSON.stringify(data));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// POST /api/tor-bridges/update
async function handleUpdateTorBridges(req, res) {
  try {
    const result = await updateTorBridgesDirectly();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: true,
      lastUpdated: result.lastUpdated,
      bridges: result.bridges
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

function processProviderLines(name, lines) {
  let isFile = false;
  let isYaml = false;
  let relativePath = '';
  const newLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed.startsWith('type: file')) {
      isFile = true;
    } else if (trimmed.startsWith('path:')) {
      relativePath = trimmed.substring(5).trim().replace(/['"]/g, '');
      if (relativePath.endsWith('.yaml')) {
        isYaml = true;
      }
    } else {
      newLines.push(line);
    }
  }
  
  if (isFile && isYaml && relativePath) {
    let absolutePath = relativePath;
    if (relativePath.startsWith('./')) {
      absolutePath = path.join('/opt/etc/mihomo', relativePath.substring(2));
    } else if (!path.isAbsolute(relativePath)) {
      absolutePath = path.join('/opt/etc/mihomo', relativePath);
    }
    
    try {
      if (fs.existsSync(absolutePath)) {
        const fileContent = fs.readFileSync(absolutePath, 'utf8');
        const fileLines = fileContent.split(/\r?\n/);
        let payloadLines = [];
        let inPayload = false;
        
        for (let j = 0; j < fileLines.length; j++) {
          const fLine = fileLines[j];
          const fTrimmed = fLine.trim();
          
          if (fTrimmed.startsWith('payload:')) {
            inPayload = true;
            continue;
          }
          
          if (inPayload) {
            if (fLine.startsWith('  -') || fLine.startsWith('  ') || fTrimmed.startsWith('-')) {
              payloadLines.push(fLine);
            }
          }
        }
        
        const resolvedLines = [];
        resolvedLines.push(`  ${name}:`);
        resolvedLines.push(`    type: inline`);
        
        for (const line of newLines) {
          if (!line.trim().endsWith(':') && line.trim() !== '') {
            resolvedLines.push(line);
          }
        }
        
        if (payloadLines.length === 0) {
          resolvedLines.push(`    payload: []`);
        } else {
          resolvedLines.push(`    payload:`);
          for (const pLine of payloadLines) {
            const cleanLine = pLine.trim();
            resolvedLines.push(`      ${cleanLine}`);
          }
        }
        
        return resolvedLines;
      }
    } catch (err) {
      console.error(`Failed to inline rule provider ${name} from ${absolutePath}:`, err.message);
    }
  }
  
  return lines;
}

function compileConfigInline(configText) {
  const lines = configText.split(/\r?\n/);
  let output = [];
  let inRuleProviders = false;
  let currentProvider = null;
  let providerLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (line.startsWith('rule-providers:')) {
      inRuleProviders = true;
      output.push(line);
      continue;
    }
    
    if (inRuleProviders) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) {
        inRuleProviders = false;
      }
    }
    
    if (inRuleProviders) {
      if (line.startsWith('  ') && !line.startsWith('   ') && trimmed.endsWith(':')) {
        if (currentProvider) {
          output.push(...processProviderLines(currentProvider, providerLines));
        }
        currentProvider = trimmed.slice(0, -1);
        providerLines = [line];
      } else if (currentProvider) {
        providerLines.push(line);
      } else {
        output.push(line);
      }
    } else {
      if (currentProvider) {
        output.push(...processProviderLines(currentProvider, providerLines));
        currentProvider = null;
        providerLines = [];
      }
      output.push(line);
    }
  }
  
  if (currentProvider) {
    output.push(...processProviderLines(currentProvider, providerLines));
  }
  
  return output.join('\n');
}

// --- Subscription Exporter: полная компиляция конфига для внешнего импорта ---
// Парсит прокси из файлов провайдеров (YAML proxies: и URI-списки vless:// и т.д.)
function parseProxiesFromProviderFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0 && !l.trim().startsWith('#'));
    
    // Определяем: это список URI или YAML?
    const isUriList = lines.some(line => {
      const lower = line.trim().toLowerCase();
      return lower.startsWith('vless://') || lower.startsWith('vmess://') || lower.startsWith('ss://') || 
             lower.startsWith('trojan://') || lower.startsWith('tuic://') || lower.startsWith('hysteria2://') || lower.startsWith('hysteria://');
    });

    if (isUriList) {
      const proxies = [];
      for (const line of lines) {
        try {
          const parsed = yamlUtils.parseProxyUri(line.trim());
          if (parsed) proxies.push(parsed);
        } catch (e) {}
      }
      return proxies;
    }

    // YAML формат: ищем секцию proxies:
    const proxies = [];
    let inProxies = false;
    let currentProxy = null;
    let inSubOpts = false;
    let subOptsKey = '';
    
    const rawLines = text.split(/\r?\n/);
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      
      if (line.startsWith('proxies:')) {
        inProxies = true;
        continue;
      }
      
      if (inProxies) {
        // Выход из секции proxies при встрече нового root-key
        if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
          if (currentProxy && currentProxy.name) proxies.push(currentProxy);
          inProxies = false;
          continue;
        }
        
        if (trimmed.startsWith('- ')) {
          if (currentProxy && currentProxy.name) proxies.push(currentProxy);
          currentProxy = {};
          inSubOpts = false;
          
          const rest = trimmed.substring(2).trim();
          const colIdx = rest.indexOf(':');
          if (colIdx !== -1) {
            const k = rest.substring(0, colIdx).trim();
            const v = rest.substring(colIdx + 1).trim().replace(/^['"]|['"]$/g, '');
            currentProxy[k] = v;
          }
        } else if (currentProxy) {
          // Определяем вложенные объекты (reality-opts, ws-opts, etc.)
          if (trimmed.endsWith(':') && !trimmed.startsWith('-')) {
            const key = trimmed.slice(0, -1).trim();
            if (key === 'reality-opts' || key === 'ws-opts' || key === 'grpc-opts' || key === 'h2-opts' || key === 'plugin-opts') {
              inSubOpts = true;
              subOptsKey = key;
              currentProxy[key] = {};
              continue;
            }
          }
          
          const colIdx = trimmed.indexOf(':');
          if (colIdx !== -1) {
            const k = trimmed.substring(0, colIdx).trim();
            const v = trimmed.substring(colIdx + 1).trim().replace(/^['"]|['"]$/g, '');
            
            // Определяем уровень вложенности по отступу
            const indent = line.length - line.trimStart().length;
            if (inSubOpts && indent >= 6) {
              currentProxy[subOptsKey][k] = v;
            } else {
              inSubOpts = false;
              currentProxy[k] = v;
            }
          }
        }
      }
    }
    if (currentProxy && currentProxy.name) proxies.push(currentProxy);
    return proxies;
  } catch (err) {
    console.error(`[Export Compiler] Failed to parse provider file ${filePath}:`, err.message);
    return [];
  }
}

// Сериализация объекта прокси в YAML-строки для вставки в proxies:
function serializeProxyObjectToYaml(proxy) {
  const lines = [];
  const name = (proxy.name || 'unknown').replace(/"/g, '\\"');
  lines.push(`  - name: "${name}"`);
  
  const simpleKeys = ['type', 'server', 'port', 'uuid', 'password', 'cipher', 'network', 'flow', 'servername', 'client-fingerprint', 'sni', 'skip-cert-verify'];
  const boolKeys = ['udp', 'tls'];
  
  for (const key of simpleKeys) {
    if (proxy[key] !== undefined && proxy[key] !== '') {
      lines.push(`    ${key}: ${proxy[key]}`);
    }
  }
  for (const key of boolKeys) {
    if (proxy[key] !== undefined) {
      lines.push(`    ${key}: ${proxy[key]}`);
    }
  }
  
  // Вложенные объекты
  const nestedKeys = ['reality-opts', 'ws-opts', 'grpc-opts', 'h2-opts', 'plugin-opts'];
  for (const key of nestedKeys) {
    if (proxy[key] && typeof proxy[key] === 'object') {
      lines.push(`    ${key}:`);
      for (const [subKey, subVal] of Object.entries(proxy[key])) {
        lines.push(`      ${subKey}: ${subVal}`);
      }
    }
  }
  
  return lines.join('\n');
}

// Главная функция: компиляция конфига для экспорта как полноценной подписки
function compileConfigForExport(configText) {
  const mihomoDir = '/opt/etc/mihomo';
  const rawLines = configText.split(/\r?\n/);
  
  // ===== ШАГ 1: Собираем proxy-providers и парсим файлы с прокси =====
  const providerProxies = new Map(); // имя провайдера -> [{name, type, ...}, ...]
  let inProxyProviders = false;
  let currentProviderName = '';
  let currentProviderPath = '';
  
  for (const line of rawLines) {
    const trimmed = line.trim();
    
    if (line.startsWith('proxy-providers:')) {
      inProxyProviders = true;
      continue;
    }
    if (inProxyProviders) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
        inProxyProviders = false;
        continue;
      }
      // Определяем имя провайдера (отступ 2 пробела, заканчивается на :)
      if (line.startsWith('  ') && !line.startsWith('    ') && trimmed.endsWith(':')) {
        if (currentProviderName && currentProviderPath) {
          let absPath = currentProviderPath;
          if (absPath.startsWith('./')) absPath = path.join(mihomoDir, absPath.substring(2));
          else if (!path.isAbsolute(absPath)) absPath = path.join(mihomoDir, absPath);
          providerProxies.set(currentProviderName, parseProxiesFromProviderFile(absPath));
        }
        currentProviderName = trimmed.slice(0, -1);
        currentProviderPath = '';
      }
      if (trimmed.startsWith('path:')) {
        currentProviderPath = trimmed.substring(5).trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }
  // Последний провайдер
  if (currentProviderName && currentProviderPath) {
    let absPath = currentProviderPath;
    if (absPath.startsWith('./')) absPath = path.join(mihomoDir, absPath.substring(2));
    else if (!path.isAbsolute(absPath)) absPath = path.join(mihomoDir, absPath);
    providerProxies.set(currentProviderName, parseProxiesFromProviderFile(absPath));
  }
  
  console.log(`[Export Compiler] Parsed ${providerProxies.size} proxy providers:`);
  for (const [name, list] of providerProxies) {
    console.log(`  - ${name}: ${list.length} proxies`);
  }
  
  // ===== ШАГ 2: Формируем результирующий конфиг =====
  const output = [];
  let inPP = false; // inside proxy-providers section (skip it entirely)
  let inProxyGroups = false;
  let currentGroupLines = [];
  let skipSection = false;
  
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();
    
    // Определяем root-level секции
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('#')) {
      // Завершаем предыдущую группу если были в proxy-groups
      if (inProxyGroups && currentGroupLines.length > 0) {
        output.push(...flattenGroupBlock(currentGroupLines, providerProxies));
        currentGroupLines = [];
      }
      
      if (line.startsWith('proxy-providers:')) {
        inPP = true;
        inProxyGroups = false;
        skipSection = false;
        continue;
      }
      if (line.startsWith('proxy-groups:')) {
        inPP = false;
        inProxyGroups = true;
        skipSection = false;
        output.push(line);
        continue;
      }
      // Любая другая root секция
      inPP = false;
      inProxyGroups = false;
      skipSection = false;
    }
    
    // Пропускаем содержимое proxy-providers целиком
    if (inPP) continue;
    
    // Собираем строки proxy-groups для пост-обработки
    if (inProxyGroups) {
      // Если встретили начало новой группы (  - name:), обрабатываем предыдущую
      if (trimmed.startsWith('- name:') && currentGroupLines.length > 0) {
        output.push(...flattenGroupBlock(currentGroupLines, providerProxies));
        currentGroupLines = [];
      }
      currentGroupLines.push(line);
      continue;
    }
    
    output.push(line);
  }
  
  // Финализируем последнюю группу
  if (currentGroupLines.length > 0) {
    output.push(...flattenGroupBlock(currentGroupLines, providerProxies));
  }
  
  // ===== ШАГ 3: Вставляем все прокси из провайдеров в секцию proxies: =====
  const allProviderProxies = [];
  for (const list of providerProxies.values()) {
    allProviderProxies.push(...list);
  }
  
  if (allProviderProxies.length > 0) {
    let proxiesIdx = output.findIndex(l => l.startsWith('proxies:'));
    const proxyYamlLines = allProviderProxies.map(p => serializeProxyObjectToYaml(p));
    
    if (proxiesIdx === -1) {
      // Вставляем секцию proxies: перед proxy-groups:
      const groupsIdx = output.findIndex(l => l.startsWith('proxy-groups:'));
      if (groupsIdx !== -1) {
        output.splice(groupsIdx, 0, 'proxies:', ...proxyYamlLines, '');
      } else {
        output.push('proxies:');
        output.push(...proxyYamlLines);
      }
    } else {
      // Вставляем прокси после существующей секции proxies:
      // Находим конец секции proxies
      let insertAfter = proxiesIdx;
      for (let j = proxiesIdx + 1; j < output.length; j++) {
        const l = output[j];
        if (l.length > 0 && !l.startsWith(' ') && !l.startsWith('\t') && !l.startsWith('#')) {
          insertAfter = j;
          break;
        }
        insertAfter = j + 1;
      }
      output.splice(insertAfter, 0, ...proxyYamlLines);
    }
  }
  
  // ===== ШАГ 4: Инлайним rule-providers (используем существующую логику) =====
  let result = output.join('\n');
  result = compileConfigInline(result);
  
  return result;
}

// Обработка блока proxy-group: заменяет use: [provider1, ...] на proxies: [node1, node2, ...]
function flattenGroupBlock(groupLines, providerProxies) {
  const result = [];
  let useProviders = [];
  let inUse = false;
  let proxiesLineIdx = -1;
  let hasExistingProxies = false;
  
  for (const line of groupLines) {
    const trimmed = line.trim();
    
    // Обнаруживаем use:
    if (trimmed.startsWith('use:')) {
      inUse = true;
      const rest = trimmed.substring(4).trim();
      if (rest.startsWith('[') && rest.endsWith(']')) {
        // Inline формат: use: [provider1, provider2]
        const names = rest.substring(1, rest.length - 1).split(',').map(n => n.trim().replace(/^['"]|['"]$/g, ''));
        useProviders.push(...names.filter(n => n.length > 0));
        inUse = false;
      } else if (rest.length > 0) {
        useProviders.push(rest.replace(/^['"]|['"]$/g, ''));
        inUse = false;
      }
      continue; // Не добавляем use: в результат
    }
    
    if (inUse) {
      if (trimmed.startsWith('-')) {
        useProviders.push(trimmed.substring(1).trim().replace(/^['"]|['"]$/g, ''));
        continue;
      } else {
        inUse = false;
      }
    }
    
    if (trimmed.startsWith('proxies:')) {
      proxiesLineIdx = result.length;
      hasExistingProxies = true;
    }
    
    result.push(line);
  }
  
  // Если были use: провайдеры, резолвим их в имена прокси
  if (useProviders.length > 0) {
    const resolvedNames = [];
    for (const providerName of useProviders) {
      const list = providerProxies.get(providerName) || [];
      for (const p of list) {
        if (p.name) resolvedNames.push(p.name);
      }
    }
    
    if (resolvedNames.length > 0) {
      const proxyLines = resolvedNames.map(name => `      - "${name.replace(/"/g, '\\"')}"`);
      
      if (proxiesLineIdx !== -1) {
        // Вставляем после строки proxies:
        // Ищем конец существующего блока proxies
        let insertAt = proxiesLineIdx + 1;
        while (insertAt < result.length && result[insertAt].trim().startsWith('-')) {
          insertAt++;
        }
        result.splice(insertAt, 0, ...proxyLines);
      } else {
        // Добавляем proxies: в конец группы
        result.push('    proxies:');
        result.push(...proxyLines);
      }
    }
  }
  
  return result;
}

function getConfigFilesList() {
  const files = [];
  const baseDir = '/opt/etc/mihomo';
  
  // 1. Основные файлы в /opt/etc/mihomo
  if (fs.existsSync(baseDir)) {
    const baseFiles = fs.readdirSync(baseDir);
    for (const file of baseFiles) {
      if (file.endsWith('.yaml')) {
        const fullPath = path.join(baseDir, file);
        try {
          if (fs.statSync(fullPath).isFile()) {
            const id = file.replace('.yaml', '');
            files.push({
              id: id,
              name: id,
              path: fullPath
            });
          }
        } catch (e) {}
      }
    }
  }
  
  // 2. Файлы правил в /opt/etc/mihomo/rules/
  const rulesDir = path.join(baseDir, 'rules');
  if (fs.existsSync(rulesDir)) {
    const ruleFiles = fs.readdirSync(rulesDir);
    for (const file of ruleFiles) {
      if (file.endsWith('.yaml')) {
        const fullPath = path.join(rulesDir, file);
        try {
          if (fs.statSync(fullPath).isFile()) {
            const id = 'rules_' + file.replace('.yaml', '');
            files.push({
              id: id,
              name: 'rules/' + file.replace('.yaml', ''),
              path: fullPath
            });
          }
        } catch (e) {}
      }
    }
  }
  
  // Добавляем виртуальный файл скомпилированного конфига для экспорта
  files.push({
    id: 'config_compiled',
    name: 'config_compiled (экспорт)',
    path: 'virtual'
  });
  
  // Всегда возвращаем первым config
  files.sort((a, b) => {
    if (a.id === 'config') return -1;
    if (b.id === 'config') return 1;
    if (a.id === 'config_compiled') return -1;
    if (b.id === 'config_compiled') return 1;
    return a.name.localeCompare(b.name);
  });
  
  return files;
}

function getFilePathFromId(id) {
  if (id === 'config_compiled') {
    return 'virtual';
  }
  if (!id || id === 'config') {
    return configPath;
  }
  const files = getConfigFilesList();
  const file = files.find(f => f.id === id);
  if (file) {
    return file.path;
  }
  return null;
}

// GET /api/config/files
function handleGetConfigFiles(req, res) {
  try {
    const files = getConfigFilesList();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, files }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

function stripRoutingRules(configText) {
  const lines = configText.split(/\r?\n/);
  const output = [];
  let inRules = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('rules:')) {
      inRules = true;
      output.push('rules:');
      output.push('  - MATCH,GLOBAL');
      continue;
    }
    
    if (inRules) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) {
        inRules = false;
        output.push(line);
      }
    } else {
      output.push(line);
    }
  }
  return output.join('\n');
}

// Извлекает ТОЛЬКО исходящие правила маршрутизации (без локальных rules роутера)
function extractOutboundRules(configText) {
  const lines = configText.split(/\r?\n/);
  const output = ['rules:'];
  let inRules = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (line.startsWith('rules:')) {
      inRules = true;
      continue;
    }

    if (inRules) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('#')) {
        break;
      }

      if (trimmed.includes('SRC-IP-CIDR') || trimmed.includes('SRC-PORT')) {
        continue;
      }
      if (trimmed.includes('CLIENTS BYPASS RULES') || trimmed.includes('CLIENTS VPN RULES')) {
        continue;
      }

      if (trimmed.length > 0) {
        output.push(line);
      }
    }
  }

  return output.join('\n');
}

// Очищает скомпилированный конфиг подписки от локальных правил роутера
function stripLocalRules(configText) {
  const lines = configText.split(/\r?\n/);
  const output = [];
  let inRules = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (line.startsWith('rules:')) {
      inRules = true;
      output.push(line);
      continue;
    }

    if (inRules) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('#')) {
        inRules = false;
        output.push(line);
        continue;
      }

      if (trimmed.includes('SRC-IP-CIDR') || trimmed.includes('SRC-PORT')) {
        continue;
      }
      if (trimmed.includes('CLIENTS BYPASS RULES') || trimmed.includes('CLIENTS VPN RULES')) {
        continue;
      }
    }

    output.push(line);
  }

  return output.join('\n');
}

function getWifiInfo() {
  try {
    const fs = require('fs');
    if (fs.existsSync('/etc/config/wireless')) {
      const content = fs.readFileSync('/etc/config/wireless', 'utf8');
      const lines = content.split('\n');
      let ssid = '';
      let key = '';
      let encryption = 'WPA';
      
      for (let line of lines) {
        line = line.trim();
        if (line.startsWith('option ssid')) {
          ssid = line.split("'")[1] || line.split('"')[1] || line.split(/\s+/)[2] || '';
        }
        if (line.startsWith('option key')) {
          key = line.split("'")[1] || line.split('"')[1] || line.split(/\s+/)[2] || '';
        }
        if (line.startsWith('option encryption')) {
          const enc = line.split("'")[1] || line.split('"')[1] || line.split(/\s+/)[2] || '';
          if (enc.includes('wep')) encryption = 'WEP';
          else if (enc === 'none') encryption = 'nopass';
          else encryption = 'WPA';
        }
      }
      if (ssid) {
        return { success: true, ssid, key, encryption };
      }
    }
  } catch (e) {
    console.error('Failed to read /etc/config/wireless:', e.message);
  }
  return { success: true, ssid: 'Netcraze-9884', key: 'vPx8hr2A', encryption: 'WPA' };
}

function handleGetWifiInfo(req, res) {
  try {
    const info = getWifiInfo();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(info));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// GET /api/config
function handleGetConfig(req, res) {
  try {
    const urlObj = new URL(req.url, 'http://' + req.headers.host);
    const fileId = urlObj.searchParams.get('file') || 'config';
    
    if (fileId === 'config_compiled') {
      if (fs.existsSync(configPath)) {
        const configText = fs.readFileSync(configPath, 'utf8');
        let compiled = compileConfigForExport(configText);
        compiled = stripLocalRules(compiled);
        
        const routingParam = urlObj.searchParams.get('routing');
        if (routingParam === 'false') {
          compiled = stripRoutingRules(compiled);
        }
        
        res.writeHead(200, { 
          'Content-Type': 'text/yaml; charset=utf-8',
          'Content-Disposition': 'inline; filename="mihomo_config.yaml"',
          'Profile-Update-Interval': '24'
        });
        res.end(compiled);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Главный конфигурационный файл не найден');
      }
      return;
    }

    if (fileId === 'outbound_rules' || fileId === 'rules') {
      if (fs.existsSync(configPath)) {
        const configText = fs.readFileSync(configPath, 'utf8');
        const outboundRules = extractOutboundRules(configText);
        res.writeHead(200, { 
          'Content-Type': 'text/yaml; charset=utf-8',
          'Content-Disposition': 'inline; filename="outbound_rules.yaml"'
        });
        res.end(outboundRules);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Главный конфигурационный файл не найден');
      }
      return;
    }

    const filePath = getFilePathFromId(fileId);
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Недопустимый файл конфигурации');
      return;
    }

    if (fs.existsSync(filePath)) {
      const configText = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(configText);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Файл не найден: ' + filePath);
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(err.message);
  }
}

// POST /api/config
function handleSaveConfig(req, res) {
  const urlObj = new URL(req.url, 'http://' + req.headers.host);
  const fileId = urlObj.searchParams.get('file') || 'config';
  
  if (fileId === 'config_compiled') {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, message: 'Скомпилированный файл предназначен только для чтения и экспорта' }));
    return;
  }

  const filePath = getFilePathFromId(fileId);
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, message: 'Недопустимый файл конфигурации' }));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    const backupPath = filePath + '.tmp_bak';
    let backupCreated = false;
    try {
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, backupPath);
        backupCreated = true;
      }
      fs.writeFileSync(filePath, body, 'utf8');
      
      const reloadRes = await makeMihomoRequest('PUT', '/configs', { path: configPath });
      if (reloadRes.statusCode !== 200 && reloadRes.statusCode !== 204) {
        let errorMsg = 'Mihomo API вернул код ' + reloadRes.statusCode;
        try {
          const parsedError = JSON.parse(reloadRes.data);
          if (parsedError.message) errorMsg = parsedError.message;
        } catch (e) {}
        throw new Error(errorMsg);
      }
      
      if (backupCreated) {
        fs.copyFileSync(backupPath, filePath + '.bak');
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      if (backupCreated && fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, filePath);
        fs.unlinkSync(backupPath);
      }
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: err.message }));
    }
  });
}

// POST /api/import-proxies
function handleImportProxies(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    const backupPath = configPath + '.tmp_bak';
    try {
      const payload = JSON.parse(body);
      const { links, groups } = payload;
      
      if (!links || !Array.isArray(links) || links.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Нет ссылок для импорта' }));
        return;
      }
      
      const parsedProxies = [];
      for (const link of links) {
        try {
          const parsed = yamlUtils.parseProxyUri(link);
          if (parsed) parsedProxies.push(parsed);
        } catch (e) {
          console.error('Ошибка импорта ссылки: ' + link, e.message);
        }
      }
      
      if (parsedProxies.length === 0) {
        throw new Error('Ни одна ссылка не была распознана. Проверьте правильность ссылок.');
      }
      
      fs.copyFileSync(configPath, backupPath);
      
      let yamlText = fs.readFileSync(configPath, 'utf8');
      let lines = yamlText.split(/\r?\n/);
      
      for (const proxy of parsedProxies) {
        const proxyYaml = yamlUtils.serializeProxyToYaml(proxy);
        yamlUtils.injectProxyIntoConfig(lines, proxyYaml);
        
        if (groups && Array.isArray(groups)) {
          for (const groupName of groups) {
            yamlUtils.injectProxyIntoGroup(lines, groupName, proxy.name);
          }
        }
      }
      
      fs.writeFileSync(configPath, lines.join('\n'), 'utf8');
      
      const reloadRes = await makeMihomoRequest('PUT', '/configs', { path: configPath });
      if (reloadRes.statusCode !== 200 && reloadRes.statusCode !== 204) {
        let errorMsg = 'Mihomo API вернул код ' + reloadRes.statusCode;
        try {
          const parsedError = JSON.parse(reloadRes.data);
          if (parsedError.message) errorMsg = parsedError.message;
        } catch (e) {}
        throw new Error(errorMsg);
      }
      
      fs.copyFileSync(backupPath, configPath + '.bak');
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, count: parsedProxies.length }));
    } catch (err) {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, configPath);
        fs.unlinkSync(backupPath);
      }
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: err.message }));
    }
  });
}

// GET /api/providers
async function handleGetProviders(req, res) {
  try {
    let yamlText = '';
    if (fs.existsSync(configPath)) {
      yamlText = fs.readFileSync(configPath, 'utf8');
    }
    const providers = yamlUtils.getProxyProvidersFromConfig(yamlText);
    
    let mihomoProviders = {};
    try {
      const mRes = await makeMihomoRequest('GET', '/providers/proxies');
      if (mRes.statusCode === 200) {
        const payload = JSON.parse(mRes.data);
        mihomoProviders = payload.providers || {};
      }
    } catch (err) {
      console.error('Ошибка связи с API Mihomo при получении подписок:', err.message);
    }
    
    const merged = providers.map(p => {
      const m = mihomoProviders[p.name] || {};
      return {
        name: p.name,
        url: p.url,
        interval: p.interval,
        count: Array.isArray(m.proxies) ? m.proxies.length : undefined,
        updatedAt: m.updatedAt || null
      };
    });
    
    const groups = getGlobalGroupsFromConfig() || [];
    
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, list: merged, groups }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// POST /api/providers/add
function handleAddProvider(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    const backupPath = configPath + '.tmp_bak';
    try {
      const payload = JSON.parse(body);
      const { name, url, interval, groups } = payload;
      
      if (!name || !url || isNaN(interval)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Неполные параметры' }));
        return;
      }
      
      fs.copyFileSync(configPath, backupPath);
      
      let yamlText = fs.readFileSync(configPath, 'utf8');
      yamlText = yamlUtils.addProviderToConfig(yamlText, name, url, interval);
      
      let lines = yamlText.split(/\r?\n/);
      if (groups && Array.isArray(groups)) {
        for (const groupName of groups) {
          yamlUtils.addUseToGroupInLines(lines, groupName, name);
        }
      }
      
      fs.writeFileSync(configPath, lines.join('\n'), 'utf8');
      
      const reloadRes = await makeMihomoRequest('PUT', '/configs', { path: configPath });
      if (reloadRes.statusCode !== 200 && reloadRes.statusCode !== 204) {
        let errorMsg = 'Mihomo API вернул код ' + reloadRes.statusCode;
        try {
          const parsedError = JSON.parse(reloadRes.data);
          if (parsedError.message) errorMsg = parsedError.message;
        } catch (e) {}
        throw new Error(errorMsg);
      }
      
      fs.copyFileSync(backupPath, configPath + '.bak');
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, configPath);
        fs.unlinkSync(backupPath);
      }
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: err.message }));
    }
  });
}

// POST /api/providers/edit
function handleEditProvider(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    const backupPath = configPath + '.tmp_bak';
    try {
      const payload = JSON.parse(body);
      const { name, url, interval } = payload;
      
      if (!name || !url || isNaN(interval)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Неполные параметры' }));
        return;
      }
      
      fs.copyFileSync(configPath, backupPath);
      
      let yamlText = fs.readFileSync(configPath, 'utf8');
      yamlText = yamlUtils.updateProviderInConfig(yamlText, name, url, interval);
      
      fs.writeFileSync(configPath, yamlText, 'utf8');
      
      const reloadRes = await makeMihomoRequest('PUT', '/configs', { path: configPath });
      if (reloadRes.statusCode !== 200 && reloadRes.statusCode !== 204) {
        let errorMsg = 'Mihomo API вернул код ' + reloadRes.statusCode;
        try {
          const parsedError = JSON.parse(reloadRes.data);
          if (parsedError.message) errorMsg = parsedError.message;
        } catch (e) {}
        throw new Error(errorMsg);
      }
      
      fs.copyFileSync(backupPath, configPath + '.bak');
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, configPath);
        fs.unlinkSync(backupPath);
      }
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: err.message }));
    }
  });
}

// POST /api/providers/delete
function handleDeleteProvider(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    const backupPath = configPath + '.tmp_bak';
    try {
      const payload = JSON.parse(body);
      const { name } = payload;
      
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Имя не указано' }));
        return;
      }
      
      fs.copyFileSync(configPath, backupPath);
      
      let yamlText = fs.readFileSync(configPath, 'utf8');
      yamlText = yamlUtils.deleteProviderFromConfig(yamlText, name);
      
      let lines = yamlText.split(/\r?\n/);
      yamlUtils.removeUseFromGroupsInLines(lines, name);
      
      fs.writeFileSync(configPath, lines.join('\n'), 'utf8');
      
      const reloadRes = await makeMihomoRequest('PUT', '/configs', { path: configPath });
      if (reloadRes.statusCode !== 200 && reloadRes.statusCode !== 204) {
        let errorMsg = 'Mihomo API вернул код ' + reloadRes.statusCode;
        try {
          const parsedError = JSON.parse(reloadRes.data);
          if (parsedError.message) errorMsg = parsedError.message;
        } catch (e) {}
        throw new Error(errorMsg);
      }
      
      fs.copyFileSync(backupPath, configPath + '.bak');
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, configPath);
        fs.unlinkSync(backupPath);
      }
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: err.message }));
    }
  });
}

// POST /api/providers/update
function handleUpdateProvider(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const { name } = payload;
      
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Имя не указано' }));
        return;
      }
      
      const mRes = await makeMihomoRequest('PUT', '/providers/proxies/' + encodeURIComponent(name));
      if (mRes.statusCode !== 200 && mRes.statusCode !== 204) {
        throw new Error('Mihomo API вернул код ' + mRes.statusCode);
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: err.message }));
    }
  });
}

// GET /api/proxies
async function handleGetProxies(req, res) {
  try {
    const mRes = await makeMihomoRequest('GET', '/proxies');
    if (mRes.statusCode !== 200) {
      throw new Error('Mihomo API вернул код ' + mRes.statusCode);
    }
    const payload = JSON.parse(mRes.data);
    const proxiesObj = payload.proxies || {};
    
    const excludeTypes = ['selector', 'urltest', 'fallback', 'loadbalance', 'select', 'url-test', 'direct', 'reject', 'compatible', 'pass'];
    const list = Object.keys(proxiesObj)
      .filter(name => {
        const p = proxiesObj[name];
        return p && !excludeTypes.includes(p.type.toLowerCase()) && name !== 'GLOBAL' && name !== 'DIRECT' && name !== 'REJECT';
      })
      .map(name => ({
        name: name,
        type: proxiesObj[name].type,
        server: proxiesObj[name].server || 'Подписочный узел',
        history: proxiesObj[name].history || []
      }));
      
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, list }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// POST /api/proxies/ping
function handlePingProxy(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const { name } = payload;
      
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Имя не указано' }));
        return;
      }

      // 1. Для DIRECT или REJECT всегда 1ms
      if (name === 'DIRECT' || name === 'REJECT') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, delay: 1 }));
        return;
      }
      
      const servicePingUrls = {
        'Apple': 'http://www.apple.com/library/test/success.html',
        'YouTube': 'https://www.youtube.com',
        'Discord': 'https://discord.com',
        'Telegram': 'https://telegram.org',
        'Meta': 'https://www.instagram.com',
        'Twitch': 'https://www.twitch.tv',
        'Reddit': 'https://www.reddit.com',
        'Spotify': 'https://www.spotify.com',
        'Speedtest': 'https://www.speedtest.net',
        '18+': 'https://www.pornhub.com',
        'TikTok': 'https://www.tiktok.com',
        'Steam': 'https://store.steampowered.com',
        'GitHub': 'https://github.com',
        'Google': 'http://www.gstatic.com/generate_204'
      };

      const targetPingUrl = servicePingUrls[name] || 'http://www.gstatic.com/generate_204';
      const timeout = 5000;
      const url = encodeURIComponent(targetPingUrl);

      // 2. Сначала точный прямой замер группы/узла по указанному имени
      let mRes = await makeMihomoRequest('GET', '/proxies/' + encodeURIComponent(name) + '/delay?url=' + url + '&timeout=' + timeout);
      
      if (mRes.statusCode === 200) {
        const parsed = JSON.parse(mRes.data);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, delay: parsed.delay || 0 }));
        return;
      }

      // 3. Запрашиваем списки proxies и providers для глубокого разрешения вложенных групп и нод
      const [proxiesRes, providersRes] = await Promise.all([
        makeMihomoRequest('GET', '/proxies'),
        makeMihomoRequest('GET', '/providers/proxies')
      ]);

      const proxies = (proxiesRes.statusCode === 200) ? (JSON.parse(proxiesRes.data).proxies || {}) : {};
      const providers = (providersRes.statusCode === 200) ? (JSON.parse(providersRes.data).providers || {}) : {};

      // Разворачиваем вложенные подгруппы до активного конечного узла
      let targetNode = name;
      let active = proxies[targetNode];
      let limit = 5;
      while (active && active.now && limit > 0) {
        const next = proxies[active.now];
        if (next) {
          active = next;
          targetNode = active.name || active.now;
        } else {
          targetNode = active.now;
          break;
        }
        limit--;
      }

      if (targetNode === 'DIRECT' || targetNode === 'REJECT') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, delay: 1 }));
        return;
      }

      // Пробуем замер разруленного конечного узла
      if (targetNode !== name) {
        mRes = await makeMihomoRequest('GET', '/proxies/' + encodeURIComponent(targetNode) + '/delay?url=' + url + '&timeout=' + timeout);
        if (mRes.statusCode === 200) {
          const parsed = JSON.parse(mRes.data);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, delay: parsed.delay || 0 }));
          return;
        }
      }

      // Ищем совпадение имени или разруленной ноды в подписках (providers)
      for (const [provName, provObj] of Object.entries(providers)) {
        if (provObj.proxies && Array.isArray(provObj.proxies)) {
          const found = provObj.proxies.find(p => p.name === targetNode || p.name === name);
          if (found) {
            mRes = await makeMihomoRequest('GET', '/providers/proxies/' + encodeURIComponent(provName) + '/' + encodeURIComponent(found.name) + '/delay?url=' + url + '&timeout=' + timeout);
            if (mRes.statusCode === 200) {
              const parsed = JSON.parse(mRes.data);
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: true, delay: parsed.delay || 0 }));
              return;
            }
          }
        }
      }

      // 4. Безопасный фолбэк на Cloudflare generate_204
      const fallbackUrl = encodeURIComponent('http://cp.cloudflare.com/generate_204');
      mRes = await makeMihomoRequest('GET', '/proxies/' + encodeURIComponent(name) + '/delay?url=' + fallbackUrl + '&timeout=' + timeout);
      if (mRes.statusCode === 200) {
        const parsed = JSON.parse(mRes.data);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, delay: parsed.delay || 0 }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, delay: 0 }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, message: err.message }));
    }
  });
}

// GET /api/xkeen/status
function handleGetXkeenStatus(req, res) {
  try {
    const { execSync } = require('child_process');
    try {
      execSync('pidof mihomo');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, running: true }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, running: false }));
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// POST /api/xkeen/toggle
function handleToggleXkeen(req, res) {
  try {
    const { exec } = require('child_process');
    
    // Проверяем текущее состояние
    exec('pidof mihomo', (err, stdout, stderr) => {
      const running = !err && stdout.trim().length > 0;
      const action = running ? 'stop' : 'start';
      const targetRunning = action === 'start';

      console.log(`[Toggle XKeen] Текущее состояние: ${running ? 'запущен' : 'остановлен'}. Выполняем: ${action}`);

      // Запускаем команду в фоне асинхронно
      exec('/opt/etc/init.d/S99xkeen ' + action, (cmdErr, cmdStdout, cmdStderr) => {
        if (cmdErr) {
          console.error(`Ошибка выполнения /opt/etc/init.d/S99xkeen ${action} в фоне:`, cmdErr.message);
        }
      });

      // Асинхронно опрашиваем состояние mihomo до 8 раз с интервалом 500мс
      let attempts = 0;
      const checkInterval = setInterval(() => {
        exec('pidof mihomo', (checkErr, checkStdout, checkStderr) => {
          const checkRunning = !checkErr && checkStdout.trim().length > 0;
          attempts++;

          if (checkRunning === targetRunning || attempts >= 8) {
            clearInterval(checkInterval);
            console.log(`[Toggle XKeen] Переключение завершено. Новый статус: ${checkRunning ? 'запущен' : 'остановлен'}`);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, running: checkRunning }));
          }
        });
      }, 500);
    });

  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// POST /api/xkeen/restart
function handleRestartXkeen(req, res) {
  try {
    // Отправляем ответ клиенту немедленно, чтобы избежать таймаутов и обрывов соединения
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, message: 'Служба XKeen перезапускается в фоне...' }));

    // Выполняем перезапуск в фоне с задержкой в 1 секунду, чтобы дать соединению закрыться
    setTimeout(() => {
      try {
        const { exec } = require('child_process');
        exec('/opt/etc/init.d/S99xkeen restart', (err, stdout, stderr) => {
          if (err) {
            console.error('Ошибка выполнения /opt/etc/init.d/S99xkeen restart в фоне:', err.message);
          } else {
            console.log('Служба XKeen успешно перезапущена в фоне.');
          }
        });
      } catch (cmdErr) {
        console.error('Критическая ошибка запуска перезапуска XKeen:', cmdErr.message);
      }
    }, 1000);

  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}


// POST /api/server/restart
function handleServerRestart(req, res) {
  try {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, message: 'Сервер перезапускается...' }));
    
    setTimeout(() => {
      try {
        if (clientsManager && typeof clientsManager.saveTrafficDbSync === 'function') {
          clientsManager.saveTrafficDbSync();
        }
      } catch (e) {
        console.error('Ошибка сохранения трафика перед перезапуском:', e.message);
      }
      
      const { spawn } = require('child_process');
      const child = spawn('sh', ['-c', 'sleep 1 && /opt/etc/init.d/S99vpn-updater-web restart'], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      process.exit(0);
    }, 500);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// GET /api/system/versions
function handleGetVersions(req, res) {
  const { exec } = require('child_process');
  
  exec('git rev-parse --abbrev-ref HEAD', { cwd: __dirname }, (err, stdoutBranch) => {
    if (err) {
      if (err.message.includes('not found') || err.message.includes('ENOENT')) {
        console.log('[VPN Web Controller] Git not found. Installing git via opkg...');
        exec('/opt/bin/opkg update && /opt/bin/opkg install git-http', (errInstall, stdoutInstall) => {
          if (errInstall) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Failed to auto-install git: ' + errInstall.message }));
            return;
          }
          console.log('[VPN Web Controller] Git installed successfully. Retrying versions request...');
          handleGetVersions(req, res);
        });
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
      return;
    }
    const currentBranch = stdoutBranch.trim();
    
    exec('git fetch origin ' + currentBranch, { cwd: __dirname }, (errFetch) => {
      exec('git log origin/' + currentBranch + ' -n 60 --date=short --format="%H|%ad|%an|%s"', { cwd: __dirname }, (errLog, stdoutLog) => {
        if (errLog) {
          exec('git log -n 60 --date=short --format="%H|%ad|%an|%s"', { cwd: __dirname }, (errLocalLog, stdoutLocalLog) => {
            if (errLocalLog) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: errLocalLog.message }));
              return;
            }
            parseAndSendCommits(stdoutLocalLog, currentBranch, res);
          });
          return;
        }
        parseAndSendCommits(stdoutLog, currentBranch, res);
      });
    });
  });
}

function parseAndSendCommits(logStdout, branch, res) {
  try {
    const { execSync } = require('child_process');
    const lines = logStdout.split('\n').filter(line => line.trim().length > 0);
    const commits = [];
    
    let currentHeadSha = '';
    try {
      currentHeadSha = execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim();
    } catch (e) {}

    // Хелпер для определения стабильной версии релиза
    const isStableVersion = (verStr) => {
      if (!verStr) return false;
      const clean = verStr.startsWith('v') ? verStr.substring(1) : verStr;
      return /^\d+\.\d+(\.\d+)?$/.test(clean);
    };

    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 4) continue;
      const sha = parts[0];
      const date = parts[1];
      const author = parts[2];
      const message = parts[3];
      
      let versionNum = '';
      let commitBranch = '';
      
      const releaseMsgMatch = message.match(/release:\s*v?(\d+\.\d+\.\d+)/i);
      if (releaseMsgMatch) {
        versionNum = releaseMsgMatch[1];
      } else {
        try {
          const versionJsonStr = execSync('git show ' + sha + ':public/version.json', { cwd: __dirname, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
          const versionData = JSON.parse(versionJsonStr);
          versionNum = versionData.version || sha.substring(0, 7);
          commitBranch = versionData.branch || '';
        } catch (e) {
          versionNum = sha.substring(0, 7);
        }
      }
      
      versionNum = String(versionNum);
      const displayVersion = versionNum.startsWith('v') ? versionNum : 'v' + versionNum;
      
      commits.push({
        sha,
        version: displayVersion,
        branch: commitBranch,
        date,
        author,
        message,
        current: sha === currentHeadSha
      });
    }

    // Заполнение списков изменений для каждого коммита
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      const isStable = isStableVersion(c.version);
      
      if (isStable) {
        // Находим предыдущий стабильный релиз
        let prevReleaseSha = '';
        for (let j = i + 1; j < commits.length; j++) {
          if (isStableVersion(commits[j].version)) {
            prevReleaseSha = commits[j].sha;
            break;
          }
        }
        
        let changes = [];
        try {
          let gitCmd = '';
          if (prevReleaseSha) {
            gitCmd = `git log ${prevReleaseSha}..${c.sha} --format="%s"`;
          } else {
            // Для самого первого релиза берем 10 предыдущих коммитов
            gitCmd = `git log ${c.sha} -n 10 --format="%s"`;
          }
          const changesStr = execSync(gitCmd, { cwd: __dirname }).toString().trim();
          changes = changesStr.split('\n')
            .map(line => line.trim())
            .filter(line => {
              if (line.length === 0) return false;
              const lower = line.toLowerCase();
              return !lower.startsWith('release:') && !lower.includes('bump version') && !lower.startsWith('version') && !lower.startsWith('local:');
            });
        } catch (e) {
          changes = [c.message];
        }
        c.changes = changes;
      } else {
        // Dev-коммиты просто показывают свое сообщение
        const lower = c.message.toLowerCase();
        if (lower.startsWith('release:') || lower.includes('bump version') || lower.startsWith('version') || lower.startsWith('local:')) {
          c.changes = [];
        } else {
          c.changes = [c.message];
        }
      }
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, branch, commits }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: 'parseAndSendCommits error: ' + err.message }));
  }
}

// POST /api/system/update
function handleSystemUpdate(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const { branch, sha } = payload;
      const { exec } = require('child_process');
      
      exec('git reset --hard', { cwd: __dirname }, (errReset) => {
        if (errReset) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: 'Git reset error: ' + errReset.message }));
          return;
        }
        
        if (branch) {
          exec('git checkout ' + branch, { cwd: __dirname }, (errCheckout) => {
            if (errCheckout) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: 'Git checkout branch error: ' + errCheckout.message }));
              return;
            }
            exec('git pull origin ' + branch, { cwd: __dirname }, (errPull) => {
              if (errPull) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: 'Git pull error: ' + errPull.message }));
                return;
              }
              
              updateVersionJsonBranch(branch);
              
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: true, message: 'Branch switched and pulled' }));
              
              triggerSelfRestart();
            });
          });
        } else if (sha) {
          exec('git checkout ' + sha, { cwd: __dirname }, (errCheckout) => {
            if (errCheckout) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: 'Git checkout SHA error: ' + errCheckout.message }));
              return;
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: 'SHA checked out' }));
            
            triggerSelfRestart();
          });
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: 'Missing branch or sha' }));
        }
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });
}

// GET /api/mihomo/version
function handleGetMihomoVersion(req, res) {
  const version = getMihomoVersion();
  const arch = getCpuArchitecture();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ success: true, version, arch }));
}

// Вспомогательная функция для получения текущей версии Mihomo
function getMihomoVersion() {
  const { execSync } = require('child_process');
  try {
    const output = execSync('/opt/sbin/mihomo -v 2>&1').toString().trim();
    const match = output.match(/v\d+\.\d+\.\d+/);
    if (match) {
      return match[0];
    }
    const alphaMatch = output.match(/v\d+\.\d+\.\d+-\w+/);
    if (alphaMatch) {
      return alphaMatch[0];
    }
    const parts = output.split(' ');
    for (const p of parts) {
      if (p.startsWith('v') && p.includes('.')) {
        return p;
      }
    }
    return output || 'Неизвестно';
  } catch (e) {
    return 'Не установлено';
  }
}

// Вспомогательная функция для получения архитектуры ЦП
function getCpuArchitecture() {
  const { execSync } = require('child_process');
  let arch = process.arch;
  
  if (process.platform === 'linux') {
    try {
      const uname = execSync('uname -m').toString().trim().toLowerCase();
      if (uname.includes('aarch64') || uname.includes('arm64')) {
        return 'arm64';
      }
      if (uname.includes('armv7') || uname.includes('armv8') || uname.includes('arm')) {
        return 'arm32v7';
      }
      if (uname.includes('mips64el')) {
        return 'mips64el';
      }
      if (uname.includes('mipsel') || uname.includes('mipsle')) {
        return 'mipsle';
      }
      if (uname.includes('mips')) {
        return 'mips';
      }
      if (uname.includes('x86_64') || uname.includes('amd64')) {
        return 'amd64';
      }
      if (uname.includes('i386') || uname.includes('i686')) {
        return '386';
      }
    } catch (e) {
      console.error('Error running uname -m:', e.message);
    }
  }
  
  if (arch === 'x64') return 'amd64';
  if (arch === 'ia32') return '386';
  if (arch === 'arm') return 'arm32v7';
  if (arch === 'arm64') return 'arm64';
  if (arch === 'mips' || arch === 'mipsel') return 'mipsle';
  
  return arch;
}

// Вспомогательная функция для поиска наилучшего ассета
function findBestAsset(assets, sysArch) {
  const linuxAssets = assets.filter(a => a.name.toLowerCase().includes('linux') && a.name.toLowerCase().endsWith('.gz'));
  
  if (sysArch === 'mipsle') {
    let asset = linuxAssets.find(a => a.name.toLowerCase().includes('mipsle-softfloat'));
    if (asset) return asset;
    asset = linuxAssets.find(a => a.name.toLowerCase().includes('mipsle'));
    if (asset) return asset;
  }
  
  if (sysArch === 'mips') {
    let asset = linuxAssets.find(a => a.name.toLowerCase().includes('mips-softfloat'));
    if (asset) return asset;
    asset = linuxAssets.find(a => a.name.toLowerCase().includes('mips'));
    if (asset) return asset;
  }
  
  if (sysArch === 'arm32v7') {
    let asset = linuxAssets.find(a => a.name.toLowerCase().includes('arm32v7'));
    if (asset) return asset;
    asset = linuxAssets.find(a => a.name.toLowerCase().includes('armv7'));
    if (asset) return asset;
  }
  
  let asset = linuxAssets.find(a => a.name.toLowerCase().includes(sysArch.toLowerCase()));
  if (asset) return asset;
  
  if (sysArch === 'amd64') {
    asset = linuxAssets.find(a => a.name.toLowerCase().includes('x86_64') || a.name.toLowerCase().includes('x64'));
    if (asset) return asset;
  }
  
  return null;
}

// Вспомогательная функция для парсинга What's Changed
function parseReleaseBody(body) {
  if (!body) return [];
  let lines = body.split('\n');
  let changes = [];
  let capture = false;
  
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    
    if (line.toLowerCase().includes("what's changed") || line.toLowerCase().includes("changelog")) {
      capture = true;
      continue;
    }
    
    if (capture && (line.startsWith('#') || line.toLowerCase().includes("full changelog"))) {
      break;
    }
    
    if (capture) {
      if (line.startsWith('*') || line.startsWith('-')) {
        changes.push(line.replace(/^[\*\-\s]+/, '').trim());
      }
    } else {
      if (line.startsWith('*') || line.startsWith('-')) {
        changes.push(line.replace(/^[\*\-\s]+/, '').trim());
      }
    }
  }
  
  if (changes.length === 0) {
    for (let line of lines) {
      line = line.trim();
      if (line.startsWith('*') || line.startsWith('-')) {
        changes.push(line.replace(/^[\*\-\s]+/, '').trim());
      }
      if (changes.length >= 10) break;
    }
  }
  
  return changes.slice(0, 15);
}

// Вспомогательная функция для скачивания и распаковки с редиректами через curl
function downloadAndDecompress(url, destPath) {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    const cmd = `curl -L -s -k --connect-timeout 15 --max-time 120 "${url}" | gzip -d > "${destPath}"`;
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err || !fs.existsSync(destPath) || fs.statSync(destPath).size < 1000000) {
        const fallbackCmd = `curl -L -k --connect-timeout 15 --max-time 120 "${url}" -o "${destPath}.gz" && gzip -df "${destPath}.gz"`;
        exec(fallbackCmd, { maxBuffer: 10 * 1024 * 1024 }, (err2) => {
          if (err2 || !fs.existsSync(destPath) || fs.statSync(destPath).size < 1000000) {
            return reject(new Error('Не удалось скачать файл релиза (таймаут сети или блокировка GitHub)'));
          }
          resolve();
        });
        return;
      }
      resolve();
    });
  });
}

let cachedMihomoReleases = null;
let cachedMihomoReleasesTime = 0;

// GET /api/mihomo/releases
function handleGetMihomoReleases(req, res) {
  const now = Date.now();
  if (cachedMihomoReleases && (now - cachedMihomoReleasesTime < 15 * 60 * 1000)) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, releases: cachedMihomoReleases }));
    return;
  }
  
  const options = {
    hostname: 'api.github.com',
    path: '/repos/MetaCubeX/mihomo/releases?per_page=30',
    method: 'GET',
    headers: {
      'User-Agent': 'Mihomo-Controller-Updater/1.0'
    },
    timeout: 8000
  };
  
  const githubReq = https.request(options, (githubRes) => {
    let data = '';
    githubRes.on('data', chunk => data += chunk);
    githubRes.on('end', () => {
      try {
        if (githubRes.statusCode !== 200) {
          throw new Error(`GitHub API returned status ${githubRes.statusCode}`);
        }
        
        const releasesList = JSON.parse(data);
        const parsedReleases = [];
        const sysArch = getCpuArchitecture();
        
        for (const rel of releasesList) {
          const bestAsset = findBestAsset(rel.assets || [], sysArch);
          
          parsedReleases.push({
            tag_name: rel.tag_name,
            published_at: rel.published_at,
            body: rel.body,
            changes: parseReleaseBody(rel.body),
            download_url: bestAsset ? bestAsset.browser_download_url : null,
            asset_name: bestAsset ? bestAsset.name : null
          });
        }
        
        cachedMihomoReleases = parsedReleases;
        cachedMihomoReleasesTime = now;
        
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, releases: parsedReleases }));
      } catch (err) {
        console.error('Error parsing GitHub releases:', err.message);
        if (cachedMihomoReleases) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, releases: cachedMihomoReleases, warning: 'Using stale cache due to error: ' + err.message }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      }
    });
  });
  
  githubReq.on('error', (err) => {
    console.error('GitHub API request error:', err.message);
    if (cachedMihomoReleases) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, releases: cachedMihomoReleases, warning: 'Using stale cache due to error: ' + err.message }));
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });
  
  githubReq.on('timeout', () => {
    githubReq.destroy();
    if (cachedMihomoReleases) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, releases: cachedMihomoReleases, warning: 'Using stale cache due to timeout' }));
    } else {
      res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'GitHub API request timeout' }));
    }
  });
  
  githubReq.end();
}

// POST /api/mihomo/update
function handleMihomoUpdate(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const { tag, download_url } = payload;
      
      if (!tag || !download_url) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Missing tag or download_url' }));
        return;
      }
      
      console.log(`[Mihomo Updater] Starting update to ${tag} from ${download_url}`);
      
      const tempGz = '/tmp/mihomo_new.gz';
      const tempBin = '/tmp/mihomo_new';
      const targetBin = '/opt/sbin/mihomo';
      const backupBin = '/opt/sbin/mihomo.bak';
      
      try {
        if (fs.existsSync(tempGz)) fs.unlinkSync(tempGz);
        if (fs.existsSync(tempBin)) fs.unlinkSync(tempBin);
      } catch (e) {}
      
      try {
        await downloadAndDecompress(download_url, tempBin);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Скачивание или распаковка не удалась: ' + err.message }));
        return;
      }
      
      if (!fs.existsSync(tempBin) || fs.statSync(tempBin).size === 0) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Распакованный файл пустой или не существует' }));
        return;
      }
      
      const { exec } = require('child_process');
      
      let backupCreated = false;
      try {
        if (fs.existsSync(targetBin)) {
          if (fs.existsSync(backupBin)) fs.unlinkSync(backupBin);
          fs.renameSync(targetBin, backupBin);
          backupCreated = true;
        }
      } catch (backupErr) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Не удалось создать резервную копию: ' + backupErr.message }));
        return;
      }
      
      try {
        fs.copyFileSync(tempBin, targetBin);
        fs.chmodSync(targetBin, 0o755);
      } catch (copyErr) {
        if (backupCreated) {
          try { fs.renameSync(backupBin, targetBin); } catch (e) {}
        }
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Не удалось заменить исполняемый файл: ' + copyErr.message }));
        return;
      }
      
      console.log('[Mihomo Updater] Restarting XKeen service...');
      exec('/opt/etc/init.d/S99xkeen restart', (errRestart, stdout, stderr) => {
        setTimeout(() => {
          exec('pidof mihomo', (errPid, stdoutPid) => {
            const isRunning = !errPid && stdoutPid.trim().length > 0;
            
            if (!isRunning) {
              console.error('[Mihomo Updater] New kernel failed to start! Restoring backup...');
              try {
                if (fs.existsSync(targetBin)) fs.unlinkSync(targetBin);
                if (fs.existsSync(backupBin)) {
                  fs.renameSync(backupBin, targetBin);
                  fs.chmodSync(targetBin, 0o755);
                }
                exec('/opt/etc/init.d/S99xkeen restart');
              } catch (restoreErr) {
                console.error('[Mihomo Updater] Critical: Restore failed:', restoreErr.message);
              }
              
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: 'Ядро не запустилось после обновления. Произведен откат на предыдущую версию.' }));
            } else {
              console.log('[Mihomo Updater] Kernel updated successfully. Cleaning up temp files...');
              try {
                if (fs.existsSync(tempBin)) fs.unlinkSync(tempBin);
                if (fs.existsSync(tempGz)) fs.unlinkSync(tempGz);
              } catch (e) {}
              
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: true, message: `Ядро Mihomo успешно обновлено до ${tag}` }));
            }
          });
        }, 3000);
      });
      
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });
}

function updateVersionJsonBranch(branchName) {
  const fs = require('fs');
  const path = require('path');
  const vPath = path.join(__dirname, 'public', 'version.json');
  try {
    if (fs.existsSync(vPath)) {
      const data = JSON.parse(fs.readFileSync(vPath, 'utf8'));
      data.branch = branchName;
      fs.writeFileSync(vPath, JSON.stringify(data, null, 2), 'utf8');
    }
  } catch (e) {
    console.error('Error updating version.json branch:', e.message);
  }
}

function triggerSelfRestart() {
  try {
    if (clientsManager && typeof clientsManager.saveTrafficDbSync === 'function') {
      clientsManager.saveTrafficDbSync();
    }
  } catch (e) {
    console.error('Ошибка сохранения трафика перед перезапуском:', e.message);
  }
  
  setTimeout(() => {
    const { spawn } = require('child_process');
    const child = spawn('sh', ['-c', 'sleep 1 && /opt/etc/init.d/S99vpn-updater-web restart'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    process.exit(0);
  }, 500);
}

// GET /api/xkeen/proxies
async function handleGetXkeenProxies(req, res) {
  try {
    const mRes = await makeMihomoRequest('GET', '/proxies');
    res.writeHead(mRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(mRes.data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// PUT /api/xkeen/proxies/:name
function handlePutXkeenProxy(req, res, name) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const mRes = await makeMihomoRequest('PUT', '/proxies/' + encodeURIComponent(name), payload);
      res.writeHead(mRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(mRes.data || JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });
}

// GET /api/xkeen/providers
async function handleGetXkeenProviders(req, res) {
  try {
    const mRes = await makeMihomoRequest('GET', '/providers/proxies');
    res.writeHead(mRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(mRes.data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// GET /api/xkeen/providers/:name/healthcheck
async function handleGetXkeenProviderHealth(req, res, name) {
  try {
    const mRes = await makeMihomoRequest('GET', '/providers/proxies/' + encodeURIComponent(name) + '/healthcheck');
    res.writeHead(mRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(mRes.data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// GET /api/config/routing-groups
function handleGetRoutingGroups(req, res) {
  try {
    const groups = getAllGroupsFromConfig();
    const targets = Array.from(new Set(['DIRECT', 'REJECT', ...groups]));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, targets }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// Helper to parse dynamic rules from YAML text
function parseDynamicRules(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  let inBlock = false;
  const rules = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '# --- DYNAMIC RULES ---') {
      inBlock = true;
      continue;
    }
    if (line === '# --- END DYNAMIC RULES ---') {
      inBlock = false;
      continue;
    }
    if (inBlock) {
      if (line.startsWith('-')) {
        const rulePart = line.substring(1).trim();
        const parts = rulePart.split(',').map(p => p.trim());
        if (parts.length >= 3) {
          const type = parts[0];
          const value = parts[1];
          const target = parts[2];
          const noResolve = parts.includes('no-resolve');
          rules.push({ type, value, target, noResolve });
        }
      }
    }
  }
  return rules;
}

// Helper to update dynamic rules in YAML text
function updateDynamicRulesInYaml(yamlText, newRules) {
  const lines = yamlText.split(/\r?\n/);
  const startIdx = lines.findIndex(line => line.trim() === '# --- DYNAMIC RULES ---');
  const endIdx = lines.findIndex(line => line.trim() === '# --- END DYNAMIC RULES ---');
  
  const ruleLines = [
    '  # --- DYNAMIC RULES ---',
    ...newRules.map(r => {
      let lineStr = `  - ${r.type},${r.value},${r.target}`;
      if (r.noResolve) {
        lineStr += ',no-resolve';
      }
      return lineStr;
    }),
    '  # --- END DYNAMIC RULES ---'
  ];

  if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
    lines.splice(startIdx, endIdx - startIdx + 1, ...ruleLines);
  } else {
    const customIdx = lines.findIndex(line => line.trim() === '# --- CUSTOM USER RULES ---');
    if (customIdx !== -1) {
      lines.splice(customIdx + 1, 0, ...ruleLines);
    } else {
      const rulesIdx = lines.findIndex(line => line.trim() === 'rules:');
      if (rulesIdx !== -1) {
        lines.splice(rulesIdx + 1, 0, ...ruleLines);
      } else {
        lines.push('rules:', ...ruleLines);
      }
    }
  }
  return lines.join('\n');
}

// Helper to parse all rules in order from YAML text
function parseAllRules(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const rules = [];
  let inRulesSection = false;
  let inDynamicBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line === '# --- DYNAMIC RULES ---') {
      inDynamicBlock = true;
      continue;
    }
    if (line === '# --- END DYNAMIC RULES ---') {
      inDynamicBlock = false;
      continue;
    }

    if (line === 'rules:') {
      inRulesSection = true;
      continue;
    }

    if (inRulesSection) {
      if (line.startsWith('#') || line.length === 0) {
        continue;
      }
      
      if (lines[i].length > 0 && !lines[i].startsWith(' ') && !lines[i].startsWith('-')) {
        inRulesSection = false;
        break;
      }
      
      if (line.startsWith('-')) {
        const rulePart = line.substring(1).trim();
        const commentIdx = rulePart.indexOf('#');
        let ruleClean = rulePart;
        if (commentIdx !== -1) {
          ruleClean = rulePart.substring(0, commentIdx).trim();
        }
        
        const parts = ruleClean.split(',').map(p => p.trim());
        
        if (parts.length >= 2) {
          const type = parts[0];
          let target = parts[parts.length - 1];
          let noResolve = false;
          let value = '';
          
          if (target === 'no-resolve') {
            noResolve = true;
            target = parts[parts.length - 2];
            value = parts.slice(1, parts.length - 2).join(',');
          } else {
            value = parts.slice(1, parts.length - 1).join(',');
          }

          rules.push({
            type,
            value: value || parts[1] || '',
            target: target || parts[2] || '',
            noResolve,
            dynamic: inDynamicBlock,
            lineIndex: i,
            originalLine: lines[i]
          });
        }
      }
    }
  }
  return rules;
}

// GET /api/config/dynamic-rules
function handleGetDynamicRules(req, res) {
  try {
    if (!fs.existsSync(configPath)) {
      throw new Error('Config file config.yaml not found');
    }
    const yamlText = fs.readFileSync(configPath, 'utf8');
    const rules = parseAllRules(yamlText);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, rules }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// POST /api/config/dynamic-rules
function handleAddDynamicRule(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    const backupPath = configPath + '.tmp_bak';
    try {
      const payload = JSON.parse(body);
      const { type, value, target } = payload;

      if (!type || !value || !target) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Параметры type, value и target обязательны' }));
        return;
      }

      let val = value.trim();
      let noResolve = false;

      if (type === 'IP-CIDR') {
        noResolve = true;
        if (!val.includes('/')) {
          if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(val)) {
            val = val + '/32';
          } else {
            throw new Error('Некорректный IPv4-адрес или подсеть');
          }
        }
      } else if (type === 'IP-CIDR6') {
        noResolve = true;
        if (!val.includes('/')) {
          if (/^[0-9a-fA-F:]+$/.test(val)) {
            val = val + '/128';
          } else {
            throw new Error('Некорректный IPv6-адрес или подсеть');
          }
        }
      }

      if (!fs.existsSync(configPath)) {
        throw new Error('Config file config.yaml not found');
      }

      fs.copyFileSync(configPath, backupPath);

      let yamlText = fs.readFileSync(configPath, 'utf8');
      const rules = parseDynamicRules(yamlText);

      const isDuplicate = rules.some(r => r.type === type && r.value.toLowerCase() === val.toLowerCase() && r.target === target);
      if (isDuplicate) {
        throw new Error('Такое правило уже существует');
      }

      rules.push({ type, value: val, target, noResolve });

      yamlText = updateDynamicRulesInYaml(yamlText, rules);
      fs.writeFileSync(configPath, yamlText, 'utf8');

      const reloadRes = await makeMihomoRequest('PUT', '/configs', { path: configPath });
      if (reloadRes.statusCode !== 200 && reloadRes.statusCode !== 204) {
        let errorMsg = 'Mihomo API вернул код ' + reloadRes.statusCode;
        try {
          const parsedError = JSON.parse(reloadRes.data);
          if (parsedError.message) errorMsg = parsedError.message;
        } catch (e) {}
        throw new Error(errorMsg);
      }

      fs.copyFileSync(backupPath, configPath + '.bak');
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));

    } catch (err) {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, configPath);
        fs.unlinkSync(backupPath);
      }
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });
}

// DELETE /api/config/dynamic-rules
function handleDeleteDynamicRule(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    const backupPath = configPath + '.tmp_bak';
    try {
      const payload = JSON.parse(body);
      const { type, value, target } = payload;

      if (!type || !target) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Параметры type и target обязательны' }));
        return;
      }

      if (!fs.existsSync(configPath)) {
        throw new Error('Config file config.yaml not found');
      }

      fs.copyFileSync(configPath, backupPath);

      let yamlText = fs.readFileSync(configPath, 'utf8');
      const dynamicRules = parseDynamicRules(yamlText);

      const origLength = dynamicRules.length;
      const updatedDynamicRules = dynamicRules.filter(r => 
        !(r.type === type && r.value === value && r.target === target)
      );

      if (updatedDynamicRules.length === origLength) {
        throw new Error('Правило не найдено среди пользовательских правил');
      }

      yamlText = updateDynamicRulesInYaml(yamlText, updatedDynamicRules);
      fs.writeFileSync(configPath, yamlText, 'utf8');

      const reloadRes = await makeMihomoRequest('PUT', '/configs', { path: configPath });
      if (reloadRes.statusCode !== 200 && reloadRes.statusCode !== 204) {
        let errorMsg = 'Mihomo API вернул код ' + reloadRes.statusCode;
        try {
          const parsedError = JSON.parse(reloadRes.data);
          if (parsedError.message) errorMsg = parsedError.message;
        } catch (e) {}
        throw new Error(errorMsg);
      }

      fs.copyFileSync(backupPath, configPath + '.bak');
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));

    } catch (err) {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, configPath);
        fs.unlinkSync(backupPath);
      }
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });
}

// Helper to safely modify rule target in yaml line
function modifyRuleLine(originalLine, newTarget) {
  const trimmed = originalLine.trim();
  if (!trimmed.startsWith('-')) return originalLine;

  const indent = originalLine.match(/^\s*/)[0];
  const rulePart = trimmed.substring(1).trim();
  
  // Separate comment
  const commentIdx = rulePart.indexOf('#');
  let ruleClean = rulePart;
  let commentStr = '';
  if (commentIdx !== -1) {
    ruleClean = rulePart.substring(0, commentIdx).trim();
    commentStr = ' ' + rulePart.substring(commentIdx);
  }

  const parts = ruleClean.split(',').map(p => p.trim());
  if (parts.length < 2) return originalLine;

  // If last part is no-resolve
  if (parts[parts.length - 1] === 'no-resolve') {
    if (parts.length >= 3) {
      parts[parts.length - 2] = newTarget;
    }
  } else {
    parts[parts.length - 1] = newTarget;
  }

  return `${indent}- ${parts.join(',')}${commentStr}`;
}

// PUT /api/config/dynamic-rules
function handleUpdateDynamicRuleTarget(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    const backupPath = configPath + '.tmp_bak';
    try {
      const payload = JSON.parse(body);
      const { lineIndex, originalLine, newTarget } = payload;

      if (lineIndex === undefined || originalLine === undefined || !newTarget) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Параметры lineIndex, originalLine и newTarget обязательны' }));
        return;
      }

      if (!fs.existsSync(configPath)) {
        throw new Error('Config file config.yaml not found');
      }

      fs.copyFileSync(configPath, backupPath);

      let yamlText = fs.readFileSync(configPath, 'utf8');
      const lines = yamlText.split(/\r?\n/);

      if (lineIndex < 0 || lineIndex >= lines.length) {
        throw new Error('Некорректный индекс строки правила');
      }

      const currentLine = lines[lineIndex];
      if (currentLine.trim() !== originalLine.trim()) {
        throw new Error('Конфигурация изменилась, перезагрузите страницу');
      }

      lines[lineIndex] = modifyRuleLine(currentLine, newTarget);
      yamlText = lines.join('\n');
      
      fs.writeFileSync(configPath, yamlText, 'utf8');

      const reloadRes = await makeMihomoRequest('PUT', '/configs', { path: configPath });
      if (reloadRes.statusCode !== 200 && reloadRes.statusCode !== 204) {
        let errorMsg = 'Mihomo API вернул код ' + reloadRes.statusCode;
        try {
          const parsedError = JSON.parse(reloadRes.data);
          if (parsedError.message) errorMsg = parsedError.message;
        } catch (e) {}
        throw new Error(errorMsg);
      }

      fs.copyFileSync(backupPath, configPath + '.bak');
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));

    } catch (err) {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, configPath);
        fs.unlinkSync(backupPath);
      }
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });
}

// Создаем HTTP сервер
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://' + req.headers.host);
  const pathname = urlObj.pathname;

  // Раздача статики фронтенда
  if (req.method === 'GET') {
    if (pathname === '/' || pathname === '/index.html') {
      serveStaticFile(res, 'index.html', 'text/html; charset=utf-8');
      return;
    }
    if (pathname === '/app.css') {
      serveStaticFile(res, 'app.css', 'text/css; charset=utf-8');
      return;
    }
    if (pathname === '/app.js') {
      serveStaticFile(res, 'app.js', 'application/javascript; charset=utf-8');
      return;
    }
    if (pathname === '/app_monitoring.js') {
      serveStaticFile(res, 'app_monitoring.js', 'application/javascript; charset=utf-8');
      return;
    }
    if (pathname === '/version.json') {
      serveStaticFile(res, 'version.json', 'application/json; charset=utf-8');
      return;
    }
  }

  if (req.method === 'GET' && pathname === '/api/system/stats') {
    handleGetSystemStats(req, res);
    return;
  }
  if (req.method === 'GET' && (pathname === '/api/config/rules.yaml' || pathname === '/api/export/rules.yaml' || pathname === '/rules.yaml' || pathname === '/outbound_rules.yaml')) {
    if (fs.existsSync(configPath)) {
      const configText = fs.readFileSync(configPath, 'utf8');
      const outboundRules = extractOutboundRules(configText);
      try {
        fs.writeFileSync(path.join(__dirname, 'public', 'outbound_rules.yaml'), outboundRules, 'utf8');
        fs.writeFileSync('/opt/etc/mihomo/outbound_rules.yaml', outboundRules, 'utf8');
      } catch(e) {}
      res.writeHead(200, { 
        'Content-Type': 'text/yaml; charset=utf-8',
        'Content-Disposition': 'inline; filename="outbound_rules.yaml"',
        'Profile-Update-Interval': '24'
      });
      res.end(outboundRules);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Главный конфигурационный файл не найден');
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/system/versions') {
    handleGetVersions(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/system/update') {
    handleSystemUpdate(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/mihomo/version') {
    handleGetMihomoVersion(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/mihomo/releases') {
    handleGetMihomoReleases(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/mihomo/update') {
    handleMihomoUpdate(req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/clients') {
    handleGetClients(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/clients/toggle') {
    handleToggleClientVpn(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/clients/rename') {
    handleRenameClient(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/clients/group') {
    handleSetClientGroup(req, res);
    return;
  }

  // Маршрутизация API
  if (req.method === 'GET' && pathname === '/api/data') {
    await handleGetData(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/apply') {
    handleApply(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/tor-bridges') {
    handleGetTorBridges(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/tor-bridges/update') {
    await handleUpdateTorBridges(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/wifi/info') {
    handleGetWifiInfo(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/config/files') {
    handleGetConfigFiles(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/config') {
    handleGetConfig(req, res);
    return;
  }
  if (req.method === 'GET' && (pathname === '/api/config/mihomo_full.yaml' || pathname === '/api/config/mihomo_lite.yaml')) {
    // Add fake query params to route back to handleGetConfig
    if (pathname === '/api/config/mihomo_full.yaml') {
      req.url = '/api/config?file=config_compiled';
    } else {
      req.url = '/api/config?file=config_compiled&routing=false';
    }
    handleGetConfig(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/config') {
    handleSaveConfig(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/import-proxies') {
    handleImportProxies(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/providers') {
    await handleGetProviders(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/providers/add') {
    handleAddProvider(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/providers/edit') {
    handleEditProvider(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/providers/delete') {
    handleDeleteProvider(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/providers/update') {
    handleUpdateProvider(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/proxies') {
    await handleGetProxies(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/proxies/ping') {
    handlePingProxy(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/xkeen/status') {
    handleGetXkeenStatus(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/xkeen/toggle') {
    await handleToggleXkeen(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/xkeen/restart') {
    await handleRestartXkeen(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/server/restart') {
    handleServerRestart(req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/xkeen/traffic') {
    handleXkeenTraffic(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/xkeen/logs') {
    handleXkeenLogs(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/xkeen/connections') {
    await handleXkeenConnections(req, res);
    return;
  }
  if (req.method === 'DELETE' && pathname.startsWith('/api/xkeen/connections/')) {
    const id = pathname.substring('/api/xkeen/connections/'.length);
    await handleCloseConnection(req, res, id);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/xkeen/trace') {
    await handleXkeenTrace(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/xkeen/proxies') {
    await handleGetXkeenProxies(req, res);
    return;
  }
  if (req.method === 'PUT' && pathname.startsWith('/api/xkeen/proxies/')) {
    const name = pathname.substring('/api/xkeen/proxies/'.length);
    handlePutXkeenProxy(req, res, decodeURIComponent(name));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/xkeen/providers') {
    await handleGetXkeenProviders(req, res);
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/api/xkeen/providers/') && pathname.endsWith('/healthcheck')) {
    const name = pathname.substring('/api/xkeen/providers/'.length, pathname.length - '/healthcheck'.length);
    await handleGetXkeenProviderHealth(req, res, decodeURIComponent(name));
    return;
  }

  // Динамические правила
  if (req.method === 'GET' && pathname === '/api/config/routing-groups') {
    handleGetRoutingGroups(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/config/dynamic-rules') {
    handleGetDynamicRules(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/config/dynamic-rules') {
    handleAddDynamicRule(req, res);
    return;
  }
  if (req.method === 'DELETE' && pathname === '/api/config/dynamic-rules') {
    handleDeleteDynamicRule(req, res);
    return;
  }
  if (req.method === 'PUT' && pathname === '/api/config/dynamic-rules') {
    handleUpdateDynamicRuleTarget(req, res);
    return;
  }

  // 404 по умолчанию
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
});

// Системный мониторинг роутера
function handleGetSystemStats(req, res) {
  try {
    const stats = systemStats.getSystemStats();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, stats }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}



// Получение списка клиентов
function handleGetClients(req, res) {
  try {
    const clients = clientsManager.getClientsList();
    const groups = getGlobalGroupsFromConfig() || [];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, clients, groups }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

// Включение/выключение VPN для клиента
function handleToggleClientVpn(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const { ip, vpnEnabled } = payload;
      
      await clientsManager.toggleClientVpn(ip, vpnEnabled);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });
}

// Переименование клиента
function handleRenameClient(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const { ip, name } = payload;
      
      clientsManager.renameClient(ip, name);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });
}

// Установка группы проксирования для клиента
function handleSetClientGroup(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const { ip, group } = payload;
      
      await clientsManager.setClientGroupPreference(ip, group);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });
}

const groupToNameMap = {
  'DIRECT': 'custom_direct',
  'REJECT': 'custom_reject',
  'GLOBAL': 'custom_global',
  '🚀Auto-Best': 'custom_autobest',
  '⚙️Manual 1': 'custom_manual_1',
  '⚙️Manual 2': 'custom_manual_2',
  '⚙️Manual 3': 'custom_manual_3',
  '18+': 'custom_18_plus'
};

function getGroupNameKey(group) {
  if (groupToNameMap[group]) return groupToNameMap[group];
  const sanitized = group
    .replace(/[^\w\u0400-\u04FF-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return `custom_${sanitized || 'rules'}`;
}

function readRuleProvider(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const rules = [];
  let inPayload = false;
  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('payload:')) {
      inPayload = true;
      continue;
    }
    if (inPayload) {
      if (trimmed.startsWith('-')) {
        let rule = trimmed.substring(1).trim();
        rule = rule.replace(/^['"]|['"]$/g, '');
        if (rule) {
          rules.push(rule);
        }
      } else if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith(' ')) {
        inPayload = false;
      }
    }
  }
  return rules;
}

function writeRuleProvider(filePath, rules) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const lines = [
    '# Generated by VPN Updater',
    'payload:'
  ];
  if (rules.length === 0) {
    lines.push('  # No rules');
  } else {
    const uniqueRules = [...new Set(rules)];
    for (const r of uniqueRules) {
      lines.push(`  - '${r}'`);
    }
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function parseDomainOrIp(value) {
  const clean = value.trim().toLowerCase();
  const ipPattern = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
  const ipv6Pattern = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}(\/\d{1,3})?$/;
  
  if (ipPattern.test(clean)) {
    let rule = clean;
    if (!clean.includes('/')) {
      rule = clean + '/32';
    }
    return `IP-CIDR,${rule},no-resolve`;
  } else if (clean.includes(':') && ipv6Pattern.test(clean)) {
    let rule = clean;
    if (!clean.includes('/')) {
      rule = clean + '/128';
    }
    return `IP-CIDR6,${rule},no-resolve`;
  } else {
    return `DOMAIN-SUFFIX,${clean}`;
  }
}

function ensureCustomRuleProvidersInConfig(yamlText, groupKeysAndNames) {
  let lines = yamlText.split(/\r?\n/);
  let changed = false;

  // 1. Ensure custom rule-providers are defined
  let ruleProvidersIndex = lines.findIndex(line => line.trim() === 'rule-providers:');
  if (ruleProvidersIndex !== -1) {
    for (const { key } of groupKeysAndNames) {
      let providerExists = false;
      for (let i = ruleProvidersIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('rules:')) break;
        if (line.trim().startsWith(key + ':')) {
          providerExists = true;
          break;
        }
      }
      if (!providerExists) {
        const indent = '  ';
        const providerLines = [
          `${indent}${key}:`,
          `${indent}${indent}type: file`,
          `${indent}${indent}behavior: classical`,
          `${indent}${indent}path: ./rules/${key}.yaml`
        ];
        lines.splice(ruleProvidersIndex + 1, 0, ...providerLines);
        changed = true;
        ruleProvidersIndex += providerLines.length;
      }
    }
  }

  // 2. Ensure references are in rules: section
  let rulesIndex = lines.findIndex(line => line.trim() === 'rules:');
  if (rulesIndex !== -1) {
    let customHeaderIndex = lines.findIndex(line => line.includes('--- CUSTOM USER RULES ---'));
    if (customHeaderIndex === -1) {
      let bypassEndIndex = lines.findIndex(line => line.includes('--- END CLIENTS BYPASS RULES ---'));
      if (bypassEndIndex !== -1) {
        customHeaderIndex = bypassEndIndex + 1;
      } else {
        customHeaderIndex = rulesIndex + 1;
      }
      lines.splice(customHeaderIndex, 0, '  # --- CUSTOM USER RULES ---');
      changed = true;
      if (customHeaderIndex <= rulesIndex) {
        rulesIndex++;
      }
    }

    for (const { key, group } of groupKeysAndNames) {
      let ruleExists = false;
      for (let i = rulesIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('- RULE-SET,' + key + ',')) {
          ruleExists = true;
          break;
        }
      }
      if (!ruleExists) {
        const ruleLine = `  - RULE-SET,${key},${group},no-resolve`;
        lines.splice(customHeaderIndex + 1, 0, ruleLine);
        changed = true;
      }
    }
  }

  return { yamlText: lines.join('\n'), changed };
}

function runMigration() {
  try {
    if (!fs.existsSync(configPath)) {
      console.log('[Migration] config.yaml не найден по пути ' + configPath);
      return;
    }

    const yamlText = fs.readFileSync(configPath, 'utf8');
    
    if (yamlText.includes('# --- CUSTOM USER RULES ---') || yamlText.includes('custom_direct:')) {
      console.log('[Migration] Миграция правил уже была выполнена ранее.');
      return;
    }

    console.log('[Migration] Начинаем извлечение правил из config.yaml...');
    
    // Бэкап
    const backupPath = configPath + '.migration_bak';
    fs.copyFileSync(configPath, backupPath);
    console.log('[Migration] Создан резервный бэкап ' + backupPath);

    const lines = yamlText.split(/\r?\n/);
    const startIndex = lines.findIndex(line => line.includes('--- END CLIENTS BYPASS RULES ---'));
    const endIndex = lines.findIndex(line => line.includes('RULE-SET,smart_unblock'));

    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
      console.log('[Migration] Границы блока правил не найдены, миграция пропущена.');
      return;
    }

    const customRules = [];
    const beforeLines = lines.slice(0, startIndex + 1);
    const afterLines = lines.slice(endIndex);
    const extractLines = lines.slice(startIndex + 1, endIndex);

    for (const line of extractLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      if (trimmed.startsWith('- ')) {
        const parts = trimmed.substring(2).split(',');
        if (parts.length >= 3) {
          const type = parts[0].trim();
          const pattern = parts[1].trim();
          const group = parts[2].trim();
          const noResolve = parts[3] ? parts[3].trim() === 'no-resolve' : false;
          customRules.push({ type, pattern, group, noResolve });
        }
      }
    }

    console.log(`[Migration] Извлечено правил: ${customRules.length}`);

    const groupedRules = {};
    const groupKeysAndNames = [];

    for (const rule of customRules) {
      if (!groupedRules[rule.group]) {
        groupedRules[rule.group] = [];
        groupKeysAndNames.push({
          key: getGroupNameKey(rule.group),
          group: rule.group
        });
      }
      let ruleStr = `${rule.type},${rule.pattern}`;
      if (rule.noResolve) {
        ruleStr += `,no-resolve`;
      }
      groupedRules[rule.group].push(ruleStr);
    }

    const rulesDir = '/opt/etc/mihomo/rules';
    if (!fs.existsSync(rulesDir)) {
      fs.mkdirSync(rulesDir, { recursive: true });
    }

    for (const { key, group } of groupKeysAndNames) {
      const filePath = path.join(rulesDir, `${key}.yaml`);
      writeRuleProvider(filePath, groupedRules[group]);
      console.log(`[Migration] Записано ${groupedRules[group].length} правил в ${filePath}`);
    }

    let newYamlText = [
      ...beforeLines,
      '  # --- CUSTOM USER RULES ---',
      ...groupKeysAndNames.map(({ key, group }) => `  - RULE-SET,${key},${group},no-resolve`),
      ...afterLines
    ].join('\n');

    const res = ensureCustomRuleProvidersInConfig(newYamlText, groupKeysAndNames);
    
    fs.writeFileSync(configPath, res.yamlText, 'utf8');
    console.log('[Migration] Миграция успешно завершена! config.yaml обновлен.');
  } catch (err) {
    console.error('[Migration] Ошибка при выполнении миграции:', err);
  }
}

function runMihomoMemoryOptimization() {
  try {
    if (!fs.existsSync(configPath)) {
      console.log('[Optimization] config.yaml не найден по пути ' + configPath);
      return;
    }

    let yamlText = fs.readFileSync(configPath, 'utf8');
    let changed = false;

    // 1. Проверяем, есть ли правило GEOIP,RU в конфиге
    const geoipRuRegex = /^\s*-\s*GEOIP\s*,\s*RU\s*,\s*([^,\s\n]+)(?:\s*,\s*no-resolve)?/m;
    const match = yamlText.match(geoipRuRegex);
    
    if (match) {
      const targetGroup = match[1].trim();
      console.log(`[Optimization] Найден старый GEOIP,RU направленный в группу ${targetGroup}. Применяем оптимизацию...`);

      // Добавляем geoip-ru в rule-providers если его там нет
      if (!yamlText.includes('geoip-ru:')) {
        let providersIndex = yamlText.indexOf('rule-providers:');
        if (providersIndex !== -1) {
          const providerConfig = `\n  geoip-ru:\n    type: http\n    behavior: ipcidr\n    format: mrs\n    url: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geoip/ru.mrs"\n    path: ./rules/geoip-ru.mrs\n    interval: 86400`;
          const insertIndex = providersIndex + 'rule-providers:'.length;
          yamlText = yamlText.slice(0, insertIndex) + providerConfig + yamlText.slice(insertIndex);
          changed = true;
          console.log('[Optimization] Добавлен rule-provider: geoip-ru.');
        }
      }

      // Заменяем правило
      yamlText = yamlText.replace(geoipRuRegex, `  - RULE-SET,geoip-ru,${targetGroup},no-resolve`);
      changed = true;
      console.log('[Optimization] Правило GEOIP,RU заменено на RULE-SET,geoip-ru.');
    }

    // 2. Отключаем geo-auto-update
    if (yamlText.includes('geo-auto-update: true')) {
      yamlText = yamlText.replace('geo-auto-update: true', 'geo-auto-update: false');
      changed = true;
      console.log('[Optimization] geo-auto-update установлено в false.');
    }

    if (changed) {
      fs.writeFileSync(configPath, yamlText, 'utf8');
      console.log('[Optimization] config.yaml успешно оптимизирован.');
    }

    // 3. Удаляем старые глобальные базы (если они присутствуют на диске и в конфиге нет GEOIP,RU)
    if (!yamlText.match(/^\s*-\s*GEOIP\s*,\s*RU\s*,/m)) {
      const dbFiles = [
        '/opt/etc/mihomo/GeoIP.dat',
        '/opt/etc/mihomo/GeoSite.dat',
        '/opt/etc/mihomo/geoip.metadb',
        '/opt/etc/mihomo/ASN.mmdb'
      ];
      dbFiles.forEach(file => {
        try {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
            console.log(`[Optimization] Удален неиспользуемый файл базы: ${file}`);
          }
        } catch (e) {
          console.error(`[Optimization] Не удалось удалить файл ${file}:`, e.message);
        }
      });
    }

    if (changed) {
      // 4. Перезапускаем службу XKeen
      const { exec } = require('child_process');
      console.log('[Optimization] Перезапуск службы XKeen для применения оптимизаций...');
      exec('/opt/etc/init.d/S99xkeen restart', (err, stdout, stderr) => {
        if (err) {
          console.error('[Optimization] Ошибка перезапуска XKeen:', err.message);
        } else {
          console.log('[Optimization] Служба XKeen успешно перезапущена.');
        }
      });
    } else {
      console.log('[Optimization] Оптимизация памяти уже была применена ранее.');
    }
  } catch (err) {
    console.error('[Optimization] Ошибка при выполнении оптимизации:', err);
  }
}

// Запуск миграции и оптимизации правил
runMigration();
runMihomoMemoryOptimization();

// Очистка порта перед запуском (убиваем старый процесс если есть)
function killOldProcess() {
  try {
    const { execSync } = require('child_process');
    const result = execSync(`fuser ${PORT}/tcp 2>/dev/null || true`).toString().trim();
    if (result) {
      const pids = result.split(/\s+/).filter(p => p && p !== String(process.pid));
      for (const pid of pids) {
        console.log(`[VPN Web Controller] Завершаем старый процесс на порту ${PORT}: PID=${pid}`);
        try { execSync(`kill -9 ${pid}`); } catch(e) {}
      }
      if (pids.length > 0) {
        // Ждём пока ОС освободит порт
        execSync('sleep 1');
      }
    }
  } catch (e) {
    // fuser может не быть - это нормально
  }
}

// Запуск сервера с обработкой EADDRINUSE
function startServer(attempt) {
  attempt = attempt || 1;
  if (attempt > 3) {
    console.error('[VPN Web Controller] КРИТИЧЕСКАЯ ОШИБКА: Не удалось запустить сервер после 3 попыток.');
    process.exit(1);
    return;
  }

  if (attempt > 1) {
    console.log('[VPN Web Controller] Попытка запуска #' + attempt + '...');
  }

  killOldProcess();

  server.listen(PORT, '0.0.0.0', () => {
    console.log('[VPN Web Controller] Сервер успешно запущен по адресу http://0.0.0.0:' + PORT + '/');
  });

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn('[VPN Web Controller] Порт ' + PORT + ' всё ещё занят. Повтор через 2 сек...');
      server.close();
      setTimeout(() => startServer(attempt + 1), 2000);
    } else {
      console.error('[VPN Web Controller] Ошибка сервера:', err);
      process.exit(1);
    }
  });
}

startServer();

