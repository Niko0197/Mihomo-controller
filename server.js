const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const yamlUtils = require('./yaml_utils');
const systemStats = require('./system_stats');
const clientsManager = require('./clients_manager');

const PORT = 4000;
const API_PORT = 9090;
const API_HOST = '192.168.1.1';
const configPath = '/opt/etc/mihomo/config.yaml';
const logRuPath = path.join(__dirname, 'log_ru.txt');
const torJsonPath = path.join(__dirname, 'tor_bridges.json');

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
      timeout: 5000
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

    const trimmedDomain = domain.trim().toLowerCase();
    
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
        const parts = rule.split(',');
        type = parts[0].trim().toUpperCase();
        payload = parts[1] ? parts[1].trim() : '';
        policy = parts[2] ? parts[2].trim() : '';
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
  
  // Всегда возвращаем первым config
  files.sort((a, b) => {
    if (a.id === 'config') return -1;
    if (b.id === 'config') return 1;
    return a.name.localeCompare(b.name);
  });
  
  return files;
}

function getFilePathFromId(id) {
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

// GET /api/config
function handleGetConfig(req, res) {
  try {
    const urlObj = new URL(req.url, 'http://' + req.headers.host);
    const fileId = urlObj.searchParams.get('file') || 'config';
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
      
      const timeout = 3000;
      const url = encodeURIComponent('http://www.gstatic.com/generate_204');
      const mRes = await makeMihomoRequest('GET', '/proxies/' + encodeURIComponent(name) + '/delay?url=' + url + '&timeout=' + timeout);
      
      if (mRes.statusCode === 200) {
        const parsed = JSON.parse(mRes.data);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, delay: parsed.delay || 0 }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, delay: 0 })); 
      }
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
  }

  // Маршрутизация API
  if (req.method === 'GET' && pathname === '/api/system/stats') {
    handleGetSystemStats(req, res);
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
  if (req.method === 'GET' && pathname === '/api/config/files') {
    handleGetConfigFiles(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/config') {
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
  '⚙️Manual 2': 'custom_manual_2'
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

// Запуск миграции правил
runMigration();

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

