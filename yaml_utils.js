// yaml_utils.js
// Утилиты для разбора прокси-ссылок и манипуляций с файлом конфигурации YAML построчно

function parseProxyUri(uri) {
  try {
    const url = new URL(uri.trim());
    const protocol = url.protocol.replace(':', '').toLowerCase();
    const hashName = url.hash ? decodeURIComponent(url.hash.substring(1)) : 'Imported Proxy ' + Math.floor(Math.random() * 10000);
    
    if (protocol === 'vless') {
      const uuid = url.username;
      const host = url.hostname;
      const port = parseInt(url.port, 10);
      const params = url.searchParams;
      
      const config = {
        name: hashName,
        type: 'vless',
        server: host,
        port: port,
        uuid: uuid,
        udp: true,
        tls: params.get('security') === 'reality' || params.get('security') === 'tls' || params.get('tls') === 'true',
      };
      
      const flow = params.get('flow');
      if (flow) config.flow = flow;
      
      const sni = params.get('sni');
      if (sni) config.servername = sni;
      
      if (params.get('security') === 'reality') {
        config['reality-opts'] = {
          'public-key': params.get('pbk') || '',
          'short-id': params.get('sid') || ''
        };
        const fp = params.get('fp');
        if (fp) config['client-fingerprint'] = fp;
      }
      
      const net = params.get('type');
      if (net) config.network = net;
      
      return config;
    } else if (protocol === 'ss') {
      let host = url.hostname;
      let port = parseInt(url.port, 10);
      let methodAndPassword = '';
      
      if (url.username) {
        methodAndPassword = Buffer.from(url.username, 'base64').toString('utf8');
      } else {
        const base64Part = url.href.split('//')[1].split('#')[0];
        if (base64Part.includes('@')) {
          const parts = base64Part.split('@');
          methodAndPassword = Buffer.from(parts[0], 'base64').toString('utf8');
          const hostPort = parts[1].split(':');
          host = hostPort[0];
          port = parseInt(hostPort[1], 10);
        } else {
          methodAndPassword = Buffer.from(base64Part, 'base64').toString('utf8');
        }
      }
      
      const [cipher, password] = methodAndPassword.split(':');
      if (decodedIncludesHost(methodAndPassword)) {
        const parts = methodAndPassword.split('@');
        const [c, p] = parts[0].split(':');
        const [h, pt] = parts[1].split(':');
        return {
          name: hashName,
          type: 'ss',
          server: h,
          port: parseInt(pt, 10),
          cipher: c,
          password: p,
          udp: true
        };
      }
      
      return {
        name: hashName,
        type: 'ss',
        server: host,
        port: port,
        cipher: cipher,
        password: password,
        udp: true
      };
    } else if (protocol === 'trojan') {
      const password = url.username;
      const host = url.hostname;
      const port = parseInt(url.port, 10);
      const params = url.searchParams;
      
      const config = {
        name: hashName,
        type: 'trojan',
        server: host,
        port: port,
        password: password,
        udp: true,
        tls: true
      };
      
      const sni = params.get('sni');
      if (sni) config.servername = sni;
      
      return config;
    }
  } catch (e) {
    throw new Error('Ошибка разбора ссылки: ' + e.message);
  }
  throw new Error('Неподдерживаемый протокол ссылки. Должен быть vless://, ss:// или trojan://');
}

function decodedIncludesHost(decodedStr) {
  return decodedStr.includes('@') && decodedStr.includes(':');
}

// Разбор подписок в формате V2Ray / Sing-box / Xray JSON в список объектов Mihomo
function parseV2RayOrSingboxJson(text) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return [];
  
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch (e) {
    return [];
  }

  const result = [];

  function convertOutboundToMihomo(ob, fallbackName) {
    if (!ob) return null;
    const protocol = (ob.protocol || ob.type || '').toLowerCase();
    const name = ob.tag && ob.tag !== 'proxy' && ob.tag !== 'config' ? ob.tag : (fallbackName || 'Proxy');

    if (protocol === 'vless') {
      let server = '';
      let port = 443;
      let uuid = '';
      let flow = '';

      if (ob.settings && Array.isArray(ob.settings.vnext) && ob.settings.vnext.length > 0) {
        const vn = ob.settings.vnext[0];
        server = vn.address;
        port = vn.port;
        if (Array.isArray(vn.users) && vn.users.length > 0) {
          uuid = vn.users[0].id;
          flow = vn.users[0].flow || '';
        }
      } else if (ob.server) {
        server = ob.server;
        port = ob.server_port || ob.port || 443;
        uuid = ob.uuid;
        flow = ob.flow || '';
      }

      if (!server || !port || !uuid) return null;

      const stream = ob.streamSettings || {};
      const network = stream.network || ob.network || 'tcp';
      const security = stream.security || (ob.tls && ob.tls.enabled ? (ob.tls.reality && ob.tls.reality.enabled ? 'reality' : 'tls') : 'none');
      const isReality = security === 'reality';
      const isTls = security === 'tls' || isReality;

      const proxy = {
        name,
        type: 'vless',
        server,
        port: parseInt(port, 10),
        uuid,
        network,
        udp: true
      };

      if (flow) proxy.flow = flow;
      if (isTls) proxy.tls = true;

      if (isReality) {
        const r = stream.realitySettings || (ob.tls && ob.tls.reality) || {};
        proxy['reality-opts'] = {
          'public-key': r.publicKey || r.public_key || '',
          'short-id': r.shortId || r.short_id || ''
        };
        if (r.serverName || r.server_name) proxy.servername = r.serverName || r.server_name;
        if (r.fingerprint) proxy['client-fingerprint'] = r.fingerprint;
      } else if (isTls) {
        const t = stream.tlsSettings || ob.tls || {};
        if (t.serverName || t.server_name) proxy.servername = t.serverName || t.server_name;
        if (t.fingerprint) proxy['client-fingerprint'] = t.fingerprint;
      }

      return proxy;
    }
    return null;
  }

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      if (!item) continue;
      const groupRemarks = item.remarks || ('Node ' + (i + 1));
      const outbounds = Array.isArray(item.outbounds) ? item.outbounds : (item.outbound ? [item.outbound] : []);
      
      for (const ob of outbounds) {
        if (!ob || !ob.protocol || ['freedom', 'blackhole', 'dns', 'loopback'].includes(ob.protocol)) continue;
        const proxy = convertOutboundToMihomo(ob, groupRemarks);
        if (proxy) result.push(proxy);
      }
    }
  } else if (typeof data === 'object' && data !== null) {
    const outbounds = Array.isArray(data.outbounds) ? data.outbounds : [];
    for (const ob of outbounds) {
      const proto = ob.type || ob.protocol;
      if (!proto || ['direct', 'block', 'dns', 'selector', 'urltest'].includes(proto)) continue;
      const proxy = convertOutboundToMihomo(ob, ob.tag || ob.remarks || 'Proxy');
      if (proxy) result.push(proxy);
    }
  }

  return result;
}

// Сериализация JSON-прокси в формат YAML Mihomo
function serializeProxyToYaml(proxy) {
  let yaml = `  - name: "${proxy.name.replace(/"/g, '\\"')}"\n`;
  yaml += `    type: ${proxy.type}\n`;
  yaml += `    server: ${proxy.server}\n`;
  yaml += `    port: ${proxy.port}\n`;
  
  if (proxy.uuid) yaml += `    uuid: ${proxy.uuid}\n`;
  if (proxy.password) yaml += `    password: ${proxy.password}\n`;
  if (proxy.cipher) yaml += `    cipher: ${proxy.cipher}\n`;
  if (proxy.flow) yaml += `    flow: ${proxy.flow}\n`;
  if (proxy.network) yaml += `    network: ${proxy.network}\n`;
  if (proxy.udp !== undefined) yaml += `    udp: ${proxy.udp}\n`;
  if (proxy.tls !== undefined) yaml += `    tls: ${proxy.tls}\n`;
  if (proxy.servername) yaml += `    servername: ${proxy.servername}\n`;
  if (proxy['client-fingerprint']) yaml += `    client-fingerprint: ${proxy['client-fingerprint']}\n`;
  
  if (proxy['reality-opts']) {
    yaml += `    reality-opts:\n`;
    yaml += `      public-key: ${proxy['reality-opts']['public-key']}\n`;
    yaml += `      short-id: ${proxy['reality-opts']['short-id']}\n`;
  }
  
  return yaml;
}

// Инъекция прокси-блока в config.yaml
function injectProxyIntoConfig(lines, proxyYaml) {
  let proxiesIndex = lines.findIndex(line => line.trim() === 'proxies:');
  
  if (proxiesIndex === -1) {
    const groupsIndex = lines.findIndex(line => line.trim() === 'proxy-groups:');
    if (groupsIndex !== -1) {
      lines.splice(groupsIndex, 0, 'proxies:', '');
      proxiesIndex = groupsIndex;
    } else {
      lines.push('proxies:');
      proxiesIndex = lines.length - 1;
    }
  }
  
  const pLines = proxyYaml.split('\n');
  if (pLines[pLines.length - 1] === '') pLines.pop();
  lines.splice(proxiesIndex + 1, 0, ...pLines);
}

// Инъекция имени прокси в список выбранной группы
function injectProxyIntoGroup(lines, groupName, proxyName) {
  let inGroups = false;
  let currentGroup = null;
  let insertIndex = -1;
  let indent = '      ';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed === 'proxy-groups:') {
      inGroups = true;
      continue;
    }
    
    if (inGroups && line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
      inGroups = false;
      break;
    }
    
    if (inGroups) {
      if (trimmed.startsWith('- name:')) {
        currentGroup = trimmed.replace(/- name:\s*/, '').replace(/['"]/g, '').trim();
        continue;
      }
      
      if (currentGroup === groupName && trimmed.startsWith('proxies:')) {
        insertIndex = i + 1;
        if (i + 1 < lines.length && lines[i + 1].startsWith(' ')) {
          indent = lines[i + 1].match(/^\s*/)[0];
        }
        break;
      }
    }
  }
  
  if (insertIndex !== -1) {
    const formattedName = proxyName.includes(' ') || proxyName.includes('(') || proxyName.includes(')') ? `'${proxyName}'` : proxyName;
    let alreadyExists = false;
    for (let j = insertIndex; j < lines.length; j++) {
      const l = lines[j].trim();
      if (l.startsWith('-')) {
        const item = l.substring(1).trim().replace(/['"]/g, '');
        if (item === proxyName) {
          alreadyExists = true;
          break;
        }
      } else {
        break;
      }
    }
    
    if (!alreadyExists) {
      lines.splice(insertIndex, 0, `${indent}- ${formattedName}`);
      return true;
    }
  }
  return false;
}

// Автоматическое определение пресета клиента по заголовкам
function detectClientPreset(userAgent, deviceOs) {
  const ua = (userAgent || '').toLowerCase();
  const os = (deviceOs || '').toLowerCase();
  if (ua.includes('happ')) {
    return (os.includes('ios') || ua.includes('ios')) ? 'happ_ios' : 'happ_android';
  } else if (ua.includes('v2rayng')) {
    return 'v2rayng';
  } else if (ua.includes('v2rayn')) {
    return 'v2rayn';
  } else if (ua.includes('sfa') || (ua.includes('sing-box') && os.includes('android'))) {
    return 'singbox_android';
  } else if (ua.includes('sfi') || (ua.includes('sing-box') && os.includes('ios'))) {
    return 'singbox_ios';
  } else if (ua.includes('shadowrocket')) {
    return 'shadowrocket';
  } else if (ua.includes('streisand')) {
    return 'streisand';
  } else if (ua.includes('foxray')) {
    return 'foxray';
  } else if (ua.includes('nekobox')) {
    return 'nekobox';
  } else if (ua.includes('hiddify')) {
    return 'hiddify';
  } else if (ua.includes('clashverge') || ua.includes('clash-verge')) {
    return 'clash_verge';
  } else if (ua.includes('incy')) {
    return (os.includes('ios') || ua.includes('ios')) ? 'incy_ios' : 'incy_android';
  } else if (ua.includes('mihomo')) {
    return 'mihomo';
  } else if (ua) {
    return 'custom';
  }
  return '';
}

const IGNORE_SYSTEM_GROUP_NAMES = [
  'GLOBAL', 'DIRECT', 'REJECT', '🚀Auto-Best',
  '⚙️Manual 1', '⚙️Manual 2', '⚙️Manual 3',
  '18+', 'YouTube', 'Telegram', 'OpenAI', 'Discord'
];

function getGroupCardNameForProvider(providerName) {
  if (providerName === 'stealthsurf') return '💎 StealthSurf';
  if (providerName === 'Igareck_Black_VPN') return '🎱 GitHub';
  return `⚡ ${providerName}`;
}

function isMatchingGroup(group, providerName, cardName) {
  if (!group || !group.name) return false;
  if (IGNORE_SYSTEM_GROUP_NAMES.includes(group.name)) return false;
  if (group.name.toLowerCase() === cardName.toLowerCase()) return true;
  if (group.use && group.use.length === 1 && group.use[0].toLowerCase() === providerName.toLowerCase()) return true;
  return false;
}

function getGroupForProviderInLines(lines, providerName) {
  const cardName = getGroupCardNameForProvider(providerName);
  let inGroups = false;
  let currentGroup = null;
  let foundGroup = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === 'proxy-groups:') {
      inGroups = true;
      continue;
    }

    if (inGroups) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
        break;
      }

      if (trimmed.startsWith('- name:')) {
        if (currentGroup) {
          currentGroup.endIndex = i;
          if (isMatchingGroup(currentGroup, providerName, cardName)) {
            foundGroup = currentGroup;
            break;
          }
        }
        const gName = trimmed.replace(/- name:\s*/, '').replace(/['"]/g, '').trim();
        currentGroup = {
          name: gName,
          type: 'url-test',
          use: [],
          url: '',
          interval: 300,
          tolerance: 50,
          strategy: '',
          lazy: true,
          expectedStatus: '',
          startIndex: i,
          endIndex: -1
        };
        continue;
      }

      if (currentGroup) {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx !== -1) {
          const k = trimmed.substring(0, colonIdx).trim();
          const v = trimmed.substring(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
          if (k === 'type') currentGroup.type = v;
          if (k === 'url') currentGroup.url = v;
          if (k === 'interval') currentGroup.interval = parseInt(v, 10) || 300;
          if (k === 'tolerance') currentGroup.tolerance = parseInt(v, 10) || 50;
          if (k === 'strategy') currentGroup.strategy = v;
          if (k === 'lazy') currentGroup.lazy = v === 'true';
          if (k === 'expected-status') currentGroup.expectedStatus = v;
        }

        if (trimmed.startsWith('use:')) {
          let j = i + 1;
          while (j < lines.length) {
            const uLine = lines[j].trim();
            if (uLine.startsWith('-')) {
              const uName = uLine.substring(1).trim().replace(/['"]/g, '');
              currentGroup.use.push(uName);
            } else {
              break;
            }
            j++;
          }
        }
      }
    }
  }

  if (currentGroup && !foundGroup && isMatchingGroup(currentGroup, providerName, cardName)) {
    foundGroup = currentGroup;
    foundGroup.endIndex = lines.length;
  }

  return foundGroup;
}

// Генерация блока health-check: для proxy-providers с удалением неприменимых параметров
function buildProviderHealthCheckLines(groupOptions) {
  const groupType = (groupOptions && groupOptions.groupType) || 'url-test';
  const groupUrl = (groupOptions && groupOptions.groupUrl) || 'http://www.gstatic.com/generate_204';
  const groupInterval = (groupOptions && groupOptions.groupInterval !== undefined) ? (parseInt(groupOptions.groupInterval, 10) || 300) : 300;
  const groupTolerance = (groupOptions && groupOptions.groupTolerance !== undefined) ? (parseInt(groupOptions.groupTolerance, 10) || 50) : 50;
  const groupLazy = (groupOptions && groupOptions.groupLazy !== undefined) ? Boolean(groupOptions.groupLazy) : true;

  if (groupType === 'select') {
    return [
      `    health-check:`,
      `      enable: false`
    ];
  }

  const lines = [
    `    health-check:`,
    `      enable: true`,
    `      url: ${groupUrl}`,
    `      interval: ${groupInterval}`
  ];

  if (groupType === 'url-test') {
    lines.push(`      tolerance: ${groupTolerance}`);
  }
  if (groupLazy !== undefined) {
    lines.push(`      lazy: ${groupLazy}`);
  }

  return lines;
}

// Обновление/создание привязанной группы подписки в proxy-groups: с удалением недействующих параметров
function updateProviderGroupInLines(lines, providerName, groupOptions) {
  const cardName = getGroupCardNameForProvider(providerName);
  const existingGroup = getGroupForProviderInLines(lines, providerName);

  const groupType = (groupOptions && groupOptions.groupType) || (existingGroup && existingGroup.type) || 'url-test';
  const groupUrl = (groupOptions && groupOptions.groupUrl) || (existingGroup && existingGroup.url) || 'http://www.gstatic.com/generate_204';
  const groupInterval = (groupOptions && groupOptions.groupInterval !== undefined) ? (parseInt(groupOptions.groupInterval, 10) || 300) : ((existingGroup && existingGroup.interval) || 300);
  const groupTolerance = (groupOptions && groupOptions.groupTolerance !== undefined) ? (parseInt(groupOptions.groupTolerance, 10) || 50) : ((existingGroup && existingGroup.tolerance) || 50);
  const groupStrategy = (groupOptions && groupOptions.groupStrategy) || (existingGroup && existingGroup.strategy) || 'consistent-hashing';
  const groupLazy = (groupOptions && groupOptions.groupLazy !== undefined) ? Boolean(groupOptions.groupLazy) : (existingGroup && existingGroup.lazy !== undefined ? existingGroup.lazy : true);
  const groupExpectedStatus = (groupOptions && groupOptions.groupExpectedStatus !== undefined) ? String(groupOptions.groupExpectedStatus).trim() : ((existingGroup && existingGroup.expectedStatus) || '');

  const groupName = existingGroup ? existingGroup.name : cardName;

  const newGroupLines = [
    `  - name: '${groupName}'`,
    `    type: ${groupType}`
  ];

  // strategy применяется ТОЛЬКО в load-balance
  if (groupType === 'load-balance') {
    newGroupLines.push(`    strategy: ${groupStrategy}`);
  }

  newGroupLines.push(`    use:`);
  newGroupLines.push(`      - ${providerName}`);

  // Для select все параметры проверки удаляются полностью
  if (groupType !== 'select') {
    newGroupLines.push(`    url: ${groupUrl}`);
    newGroupLines.push(`    interval: ${groupInterval}`);
    // tolerance действует ТОЛЬКО в url-test; для fallback и load-balance он удаляется
    if (groupType === 'url-test') {
      newGroupLines.push(`    tolerance: ${groupTolerance}`);
    }
    if (groupLazy !== undefined) {
      newGroupLines.push(`    lazy: ${groupLazy}`);
    }
    if (groupExpectedStatus) {
      newGroupLines.push(`    expected-status: ${groupExpectedStatus}`);
    }
  }

  if (existingGroup && existingGroup.startIndex !== -1 && existingGroup.endIndex !== -1) {
    lines.splice(existingGroup.startIndex, existingGroup.endIndex - existingGroup.startIndex, ...newGroupLines);
  } else {
    const groupsIndex = lines.findIndex(l => l.trim() === 'proxy-groups:');
    if (groupsIndex !== -1) {
      lines.splice(groupsIndex + 1, 0, ...newGroupLines, '');
      injectProxyIntoGroup(lines, 'GLOBAL', groupName);
      injectProxyIntoGroup(lines, '🚀Auto-Best', groupName);
    }
  }
}

// Чтение провайдеров подписок из config.yaml
function getProxyProvidersFromConfig(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const providers = [];
  let inProviders = false;
  let inHeaderBlock = false;
  let currentProvider = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed === 'proxy-providers:') {
      inProviders = true;
      inHeaderBlock = false;
      continue;
    }
    
    if (inProviders) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
        inProviders = false;
        inHeaderBlock = false;
        break;
      }
      
      if (line.startsWith('  ') && !line.startsWith('    ') && trimmed.endsWith(':')) {
        const nameVal = trimmed.slice(0, -1).trim().replace(/['"]/g, '');
        currentProvider = {
          name: nameVal,
          deviceName: '',
          hwid: '',
          userAgent: '',
          deviceOs: '',
          verOs: '',
          deviceModel: '',
          clientPreset: '',
          headers: {}
        };
        providers.push(currentProvider);
        inHeaderBlock = false;
        continue;
      }
      
      if (currentProvider && line.startsWith('    ') && !line.startsWith('      ')) {
        if (trimmed === 'header:') {
          inHeaderBlock = true;
          continue;
        } else {
          inHeaderBlock = false;
        }

        const colonIndex = trimmed.indexOf(':');
        if (colonIndex !== -1) {
          const key = trimmed.substring(0, colonIndex).trim();
          const val = trimmed.substring(colonIndex + 1).trim().replace(/^['"]|['"]$/g, '');
          if (key === 'url') currentProvider.url = val;
          if (key === 'interval') currentProvider.interval = parseInt(val, 10);
          if (key === 'path') currentProvider.path = val;
        }
      }

      // Парсинг заголовков, HWID и мимикрии из блока header
      if (currentProvider && inHeaderBlock) {
        if (!currentProvider.headers) currentProvider.headers = {};

        if (line.startsWith('      ') && !line.startsWith('        ') && trimmed.includes(':')) {
          const colonIndex = trimmed.indexOf(':');
          const k = trimmed.substring(0, colonIndex).trim();
          let v = trimmed.substring(colonIndex + 1).trim().replace(/^\[|\]$/g, '').replace(/^['"]|['"]$/g, '').trim();
          if (v) {
            currentProvider.headers[k] = v;
          }
          currentProvider._lastKey = k;
        } else if (line.startsWith('        - ') && currentProvider._lastKey) {
          const v = trimmed.replace(/^-\s*/, '').replace(/^['"]|['"]$/g, '').trim();
          currentProvider.headers[currentProvider._lastKey] = v;
        }

        // Обновляем структурированные поля
        const h = currentProvider.headers;
        currentProvider.hwid = h['x-hwid'] || h['X-HWID'] || h['hwid'] || '';
        currentProvider.userAgent = h['User-Agent'] || h['user-agent'] || '';
        currentProvider.deviceOs = h['x-device-os'] || h['X-Device-OS'] || '';
        currentProvider.verOs = h['x-ver-os'] || h['X-Ver-OS'] || '';
        currentProvider.deviceModel = h['x-device-model'] || h['X-Device-Model'] || h['Device-Name'] || '';
        currentProvider.deviceName = currentProvider.deviceModel || currentProvider.hwid || '';
        currentProvider.clientPreset = h['x-client-preset'] || h['X-Client-Preset'] || '';
      }
    }
  }

  // Очищаем временные ключи, определяем clientPreset и считываем параметры привязанной группы из proxy-groups
  for (const p of providers) {
    if (p._lastKey !== undefined) delete p._lastKey;
    if (!p.clientPreset) {
      p.clientPreset = detectClientPreset(p.userAgent, p.deviceOs);
    }
    const g = getGroupForProviderInLines(lines, p.name);
    if (g) {
      p.groupType = g.type || 'url-test';
      p.groupUrl = g.url || 'http://www.gstatic.com/generate_204';
      p.groupInterval = g.interval !== undefined ? g.interval : 300;
      p.groupTolerance = g.tolerance !== undefined ? g.tolerance : 50;
      p.groupStrategy = g.strategy || 'consistent-hashing';
      p.groupLazy = g.lazy !== undefined ? g.lazy : true;
      p.groupExpectedStatus = g.expectedStatus || '';
    } else {
      p.groupType = 'url-test';
      p.groupUrl = 'http://www.gstatic.com/generate_204';
      p.groupInterval = 300;
      p.groupTolerance = 50;
      p.groupStrategy = 'consistent-hashing';
      p.groupLazy = true;
      p.groupExpectedStatus = '';
    }
  }

  return providers;
}

const KNOWN_PRESET_DEFAULTS = {
  mihomo: {
    userAgent: 'mihomo/v1.18.10',
    deviceOs: 'KeeneticOS',
    verOs: '5.0.4',
    deviceModel: 'Keenetic Giga KN-1012'
  },
  happ_android: {
    userAgent: 'Happ/1.2.0 (Linux; Android 14; SM-S928B)',
    deviceOs: 'Android',
    verOs: '14',
    deviceModel: 'Samsung Galaxy S24 Ultra'
  },
  happ_ios: {
    userAgent: 'Happ/1.2.0 (iOS 18.3; iPhone16,2)',
    deviceOs: 'iOS',
    verOs: '18.3',
    deviceModel: 'iPhone 15 Pro'
  },
  v2rayng: {
    userAgent: 'v2rayNG/1.8.12 (Android 14; SM-G998B)',
    deviceOs: 'Android',
    verOs: '14',
    deviceModel: 'Samsung SM-G998B'
  },
  v2rayn: {
    userAgent: 'v2rayN/6.42',
    deviceOs: 'Windows',
    verOs: '10.0.22631',
    deviceModel: 'PC (x86_64)'
  },
  singbox_android: {
    userAgent: 'SFA/1.10.0 (Android 14; Pixel 8 Pro)',
    deviceOs: 'Android',
    verOs: '14',
    deviceModel: 'Google Pixel 8 Pro'
  },
  singbox_ios: {
    userAgent: 'SFI/1.10.0 (iOS 18.3; iPhone16,2)',
    deviceOs: 'iOS',
    verOs: '18.3',
    deviceModel: 'iPhone 15 Pro'
  },
  shadowrocket: {
    userAgent: 'Shadowrocket/2.2.35 (iOS 18.2; iPhone16,1)',
    deviceOs: 'iOS',
    verOs: '18.2',
    deviceModel: 'iPhone 15'
  },
  streisand: {
    userAgent: 'Streisand/1.6.4 (iOS 18.2; iPhone15,2)',
    deviceOs: 'iOS',
    verOs: '18.2',
    deviceModel: 'iPhone 14 Pro'
  },
  foxray: {
    userAgent: 'FoXray/1.4.2 (iOS 17.4; iPhone)',
    deviceOs: 'iOS',
    verOs: '17.4',
    deviceModel: 'iPhone'
  },
  nekobox: {
    userAgent: 'NekoBox/1.3.1 (Android 14; arm64-v8a)',
    deviceOs: 'Android',
    verOs: '14',
    deviceModel: 'Android Device'
  },
  hiddify: {
    userAgent: 'HiddifyNext/2.0.0 (Android 14; Linux)',
    deviceOs: 'Android',
    verOs: '14',
    deviceModel: 'Android Device'
  },
  clash_verge: {
    userAgent: 'ClashVerge/1.6.0 (Windows NT 10.0; Win64; x64) clash.meta',
    deviceOs: 'Windows',
    verOs: '11',
    deviceModel: 'PC'
  },
  incy_android: {
    userAgent: 'Incy/1.1.0 (Linux; Android 14; Mobile)',
    deviceOs: 'Android',
    verOs: '14',
    deviceModel: 'Android Device'
  },
  incy_ios: {
    userAgent: 'Incy/1.1.0 (iOS 18.2; iPhone16,2)',
    deviceOs: 'iOS',
    verOs: '18.2',
    deviceModel: 'iPhone 15 Pro'
  }
};

// Генерация блока header: для proxy-providers в строгом YAML-формате списков
function buildProviderHeaderLines(options) {
  if (!options) return [];
  const opts = typeof options === 'string' ? { deviceName: options } : options;

  let clientPreset = opts.clientPreset || (opts.headers && (opts.headers['x-client-preset'] || opts.headers['X-Client-Preset'])) || '';
  let userAgent = opts.userAgent || (opts.headers && (opts.headers['User-Agent'] || opts.headers['user-agent'])) || '';
  let hwid = opts.hwid || (opts.headers && (opts.headers['x-hwid'] || opts.headers['X-HWID'])) || '';
  let deviceOs = opts.deviceOs || (opts.headers && (opts.headers['x-device-os'] || opts.headers['X-Device-OS'])) || '';
  let verOs = opts.verOs || (opts.headers && (opts.headers['x-ver-os'] || opts.headers['X-Ver-OS'])) || '';
  let deviceModel = opts.deviceModel || opts.deviceName || (opts.headers && (opts.headers['x-device-model'] || opts.headers['X-Device-Model'] || opts.headers['Device-Name'])) || '';

  // Если указан пресет, но поля пустые - берем умолчания пресета
  if (clientPreset && KNOWN_PRESET_DEFAULTS[clientPreset] && clientPreset !== 'custom') {
    const d = KNOWN_PRESET_DEFAULTS[clientPreset];
    if (!userAgent) userAgent = d.userAgent;
    if (!deviceOs) deviceOs = d.deviceOs;
    if (!verOs) verOs = d.verOs;
    if (!deviceModel) deviceModel = d.deviceModel;
  }

  // Если передан только legacy deviceName без прочих настроек
  if (!userAgent && opts.deviceName) {
    userAgent = `Happ/1.2.0 (${opts.deviceName}; Linux; Android 14)`;
    if (!hwid) hwid = '9D4B2C81E70FA356';
    if (!deviceOs) deviceOs = 'Android';
  } else if (!userAgent) {
    userAgent = 'Happ/1.2.0 (Linux; Android 14; SM-S928B)';
    if (!hwid) hwid = '9D4B2C81E70FA356';
    if (!deviceOs) deviceOs = 'Android';
  }

  // Если clientPreset не задан явно, автоопределяем его
  if (!clientPreset) {
    clientPreset = detectClientPreset(userAgent, deviceOs) || 'happ_android';
  }

  const lines = ['    header:'];
  if (userAgent) lines.push(`      User-Agent: ["${userAgent}"]`);
  if (hwid) lines.push(`      x-hwid: ["${hwid}"]`);
  if (deviceOs) lines.push(`      x-device-os: ["${deviceOs}"]`);
  if (verOs) lines.push(`      x-ver-os: ["${verOs}"]`);
  if (deviceModel) {
    lines.push(`      x-device-model: ["${deviceModel}"]`);
    lines.push(`      Device-Name: ["${deviceModel}"]`);
  }
  if (clientPreset) {
    lines.push(`      x-client-preset: ["${clientPreset}"]`);
  }

  return lines;
}

// Редактирование существующего провайдера в config.yaml
function updateProviderInConfig(yamlText, name, url, interval, options) {
  const lines = yamlText.split(/\r?\n/);
  let inProviders = false;
  let provStart = -1;
  let provEnd = -1;
  let existingPath = `./proxy_providers/${name.toLowerCase().replace(/[^a-z0-9а-яё]/gi, '_')}.yaml`;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed === 'proxy-providers:') {
      inProviders = true;
      continue;
    }
    
    if (inProviders) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
        if (provStart !== -1 && provEnd === -1) provEnd = i;
        break;
      }
      
      if (line.startsWith('  ') && !line.startsWith('    ') && trimmed.endsWith(':')) {
        const pName = trimmed.slice(0, -1).trim().replace(/['"]/g, '');
        if (provStart !== -1 && provEnd === -1) {
          provEnd = i;
          break;
        }
        if (pName.toLowerCase() === name.toLowerCase()) {
          provStart = i;
        }
        continue;
      }

      if (provStart !== -1 && line.startsWith('    ') && trimmed.startsWith('path:')) {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx !== -1) {
          existingPath = trimmed.substring(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        }
      }
    }
  }
  
  if (provStart !== -1) {
    if (provEnd === -1) {
      provEnd = lines.length;
      for (let i = provStart + 1; i < lines.length; i++) {
        if (lines[i].length > 0 && !lines[i].startsWith(' ')) {
          provEnd = i;
          break;
        }
      }
    }

    const headerLines = buildProviderHeaderLines(options);
    const healthCheckLines = buildProviderHealthCheckLines(options);
    const newProviderLines = [
      `  ${name}:`,
      `    type: http`,
      `    url: "${url}"`,
      `    interval: ${interval || 3600}`,
      `    path: ${existingPath}`,
      ...headerLines,
      ...healthCheckLines
    ];

    lines.splice(provStart, provEnd - provStart, ...newProviderLines);
    updateProviderGroupInLines(lines, name, options);
  }
  
  return lines.join('\n');
}

// Добавление нового провайдера подписки в config.yaml
function addProviderToConfig(yamlText, name, url, interval, options) {
  const lines = yamlText.split(/\r?\n/);
  const providersIndex = lines.findIndex(line => line.trim() === 'proxy-providers:');
  if (providersIndex === -1) {
    throw new Error('Секция proxy-providers: не найдена в файле конфигурации');
  }
  
  const headerLines = buildProviderHeaderLines(options);
  const healthCheckLines = buildProviderHealthCheckLines(options);
  const providerYaml = [
    `  ${name}:`,
    `    type: http`,
    `    url: "${url}"`,
    `    interval: ${interval || 3600}`,
    `    path: ./proxy_providers/${name.toLowerCase().replace(/[^a-z0-9а-яё]/gi, '_')}.yaml`,
    ...headerLines,
    ...healthCheckLines
  ];

  lines.splice(providersIndex + 1, 0, ...providerYaml);
  updateProviderGroupInLines(lines, name, options);
  return lines.join('\n');
}

// Полное удаление провайдера подписки и ВСЕХ его следов из config.yaml
function purgeProviderFromConfig(yamlText, providerName) {
  if (!yamlText || !providerName) return yamlText;
  const cleanTargetName = String(providerName).trim().replace(/['"]/g, '');
  const groupCardName = getGroupCardNameForProvider(cleanTargetName);
  
  const allAliases = new Set([
    cleanTargetName,
    cleanTargetName.toLowerCase(),
    groupCardName,
    `⚡ ${cleanTargetName}`,
    `⚡${cleanTargetName}`,
    `💎 ${cleanTargetName}`,
    `💎${cleanTargetName}`,
    `🎱 ${cleanTargetName}`,
    `🎱${cleanTargetName}`,
    `🚀 ${cleanTargetName}`
  ]);

  let lines = yamlText.split(/\r?\n/);

  // 1. Удаление из секции proxy-providers:
  let inProviders = false;
  let provStart = -1;
  let provEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === 'proxy-providers:') {
      inProviders = true;
      continue;
    }

    if (inProviders) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
        if (provStart !== -1 && provEnd === -1) provEnd = i;
        break;
      }

      if (line.startsWith('  ') && !line.startsWith('    ') && trimmed.endsWith(':')) {
        const pName = trimmed.slice(0, -1).trim().replace(/['"]/g, '');
        if (provStart !== -1 && provEnd === -1) {
          provEnd = i;
          break;
        }
        if (pName.toLowerCase() === cleanTargetName.toLowerCase()) {
          provStart = i;
        }
      }
    }
  }

  if (provStart !== -1) {
    if (provEnd === -1) {
      provEnd = lines.length;
      for (let i = provStart + 1; i < lines.length; i++) {
        if (lines[i].length > 0 && !lines[i].startsWith(' ')) {
          provEnd = i;
          break;
        }
      }
    }
    lines.splice(provStart, provEnd - provStart);
  }

  // 2. Удаление связанных групп из proxy-groups:
  let inGroups = false;
  let groupStart = -1;
  let groupName = null;
  let groupLines = [];
  const groupsToDelete = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === 'proxy-groups:') {
      inGroups = true;
      continue;
    }

    if (inGroups) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
        if (groupStart !== -1 && shouldDeleteGroup(groupName, groupLines, cleanTargetName, allAliases)) {
          groupsToDelete.push({ start: groupStart, end: i, name: groupName });
        }
        break;
      }

      if (trimmed.startsWith('- name:')) {
        if (groupStart !== -1 && shouldDeleteGroup(groupName, groupLines, cleanTargetName, allAliases)) {
          groupsToDelete.push({ start: groupStart, end: i, name: groupName });
        }
        groupStart = i;
        groupName = trimmed.replace(/- name:\s*/, '').replace(/['"]/g, '').trim();
        groupLines = [line];
      } else if (groupStart !== -1) {
        groupLines.push(line);
      }
    }
  }

  if (inGroups && groupStart !== -1 && shouldDeleteGroup(groupName, groupLines, cleanTargetName, allAliases)) {
    groupsToDelete.push({ start: groupStart, end: lines.length, name: groupName });
  }

  for (let k = groupsToDelete.length - 1; k >= 0; k--) {
    const g = groupsToDelete[k];
    allAliases.add(g.name);
    lines.splice(g.start, g.end - g.start);
  }

  // 3. Удаление упоминаний из всех use: и proxies:
  let idx = 0;
  let inAnyGroup = false;
  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = line.trim();

    if (trimmed === 'proxy-groups:') {
      inAnyGroup = true;
      idx++;
      continue;
    }

    if (inAnyGroup && line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
      inAnyGroup = false;
    }

    if (inAnyGroup && trimmed.startsWith('-')) {
      const itemVal = trimmed.substring(1).trim().replace(/['"]/g, '');
      let matchFound = false;
      for (const alias of allAliases) {
        if (itemVal.toLowerCase() === alias.toLowerCase()) {
          matchFound = true;
          break;
        }
      }
      if (matchFound) {
        lines.splice(idx, 1);
        continue;
      }
    }
    idx++;
  }

  lines = cleanupHangingSections(lines);
  return lines.join('\n');
}

function shouldDeleteGroup(groupName, groupLines, providerName, allAliases) {
  if (!groupName) return false;
  if (SYSTEM_PROTECTED_GROUPS.includes(groupName)) return false;
  
  for (const alias of allAliases) {
    if (groupName.toLowerCase() === alias.toLowerCase()) return true;
  }

  let hasOtherUse = false;
  let hasThisUse = false;
  let inUse = false;
  for (const gl of groupLines) {
    const t = gl.trim();
    if (t.startsWith('use:')) {
      inUse = true;
      continue;
    }
    if (inUse && (t.startsWith('proxies:') || t.startsWith('type:') || t.startsWith('url:') || t.startsWith('interval:'))) {
      inUse = false;
    }
    if (inUse && t.startsWith('-')) {
      const uItem = t.substring(1).trim().replace(/['"]/g, '');
      if (uItem.toLowerCase() === providerName.toLowerCase()) {
        hasThisUse = true;
      } else {
        hasOtherUse = true;
      }
    }
  }

  if (hasThisUse && !hasOtherUse) return true;
  return false;
}

function cleanupHangingSections(lines) {
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if ((trimmed === 'use:' || trimmed === 'proxies:') && (i + 1 >= lines.length || !lines[i + 1].trim().startsWith('-'))) {
      continue;
    }
    result.push(line);
  }
  return result;
}

// Удаление провайдера подписки из config.yaml (алиас для purgeProviderFromConfig)
function deleteProviderFromConfig(yamlText, name) {
  return purgeProviderFromConfig(yamlText, name);
}

// Добавление провайдера в "use:" список прокси-группы
function addUseToGroupInLines(lines, groupName, providerName) {
  let inProxyGroups = false;
  let currentGroup = null;
  let useIndex = -1;
  let indent = '      ';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed === 'proxy-groups:') {
      inProxyGroups = true;
      continue;
    }
    
    if (inProxyGroups && line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
      inProxyGroups = false;
      break;
    }
    
    if (inProxyGroups) {
      if (trimmed.startsWith('- name:')) {
        currentGroup = trimmed.replace(/- name:\s*/, '').replace(/['"]/g, '').trim();
        continue;
      }
      
      if (currentGroup === groupName) {
        if (trimmed.startsWith('use:')) {
          useIndex = i + 1;
          if (i + 1 < lines.length && lines[i + 1].startsWith(' ')) {
            indent = lines[i + 1].match(/^\s*/)[0];
          }
          break;
        }
      }
    }
  }
  
  if (useIndex !== -1) {
    lines.splice(useIndex, 0, `${indent}- ${providerName}`);
    return true;
  }
  return false;
}

// Удаление упоминаний провайдера из "use:" списков прокси-групп
function removeUseFromGroupsInLines(lines, providerName) {
  let inProxyGroups = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed === 'proxy-groups:') {
      inProxyGroups = true;
      i++;
      continue;
    }
    
    if (inProxyGroups && line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
      inProxyGroups = false;
    }
    
    if (inProxyGroups) {
      if (trimmed.startsWith('-') && trimmed.substring(1).trim().replace(/['"]/g, '') === providerName) {
        let isUnderUse = false;
        for (let j = i - 1; j >= 0; j--) {
          const prevTrimmed = lines[j].trim();
          if (prevTrimmed.startsWith('use:')) {
            isUnderUse = true;
            break;
          }
          if (prevTrimmed.startsWith('- name:') || prevTrimmed.length === 0 || (!lines[j].startsWith(' ') && !lines[j].startsWith('-'))) {
            break;
          }
        }
        
        if (isUnderUse) {
          lines.splice(i, 1);
          continue; 
        }
      }
    }
    i++;
  }
}

const SYSTEM_PROTECTED_GROUPS = [
  'GLOBAL', 'DIRECT', 'REJECT', '🚀Auto-Best', '⚙️Manual 1', '⚙️Manual 2', '⚙️Manual 3',
  '18+', 'YouTube', 'Discord', 'Twitch', 'Reddit', 'Meta', 'Spotify', 'Speedtest',
  'Telegram', 'Viber', 'Steam', 'CDN', 'Google', 'GitHub', 'AI', 'Roblox', 'Twitter',
  'OpenAI', 'Anthropic', 'TikTok', 'Apple', 'Microsoft', 'Netflix', 'Pinterest',
  'PlayStation', 'Zoom', 'Docker', 'Epic Games', 'Riot Games', 'LinkedIn', 'Notion',
  'Patreon', 'SoundCloud', 'Xbox', 'Blizzard', 'Nintendo', 'GitLab', 'Hardware drivers'
];

// Автоматическая очистка пользовательских групп без proxies/use и удаление их упоминаний из других групп
function cleanupEmptyGroupsInLines(lines) {
  let inProxyGroups = false;
  let currentGroupStart = -1;
  let currentGroupName = '';
  let hasProxiesOrUse = false;
  const groupsToRemove = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === 'proxy-groups:') {
      inProxyGroups = true;
      continue;
    }

    if (inProxyGroups) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
        if (currentGroupStart !== -1 && !hasProxiesOrUse && currentGroupName && !SYSTEM_PROTECTED_GROUPS.includes(currentGroupName)) {
          groupsToRemove.push(currentGroupName);
        }
        inProxyGroups = false;
        currentGroupStart = -1;
        currentGroupName = '';
        continue;
      }

      if (trimmed.startsWith('- name:')) {
        if (currentGroupStart !== -1 && !hasProxiesOrUse && currentGroupName && !SYSTEM_PROTECTED_GROUPS.includes(currentGroupName)) {
          groupsToRemove.push(currentGroupName);
        }
        currentGroupStart = i;
        currentGroupName = trimmed.replace(/- name:\s*/, '').replace(/['"]/g, '').trim();
        hasProxiesOrUse = false;
        continue;
      }

      if (currentGroupStart !== -1) {
        if (trimmed.startsWith('proxies:') || trimmed.startsWith('use:')) {
          if (i + 1 < lines.length && lines[i + 1].trim().startsWith('-')) {
            hasProxiesOrUse = true;
          }
        }
      }
    }
  }

  if (inProxyGroups && currentGroupStart !== -1 && !hasProxiesOrUse && currentGroupName && !SYSTEM_PROTECTED_GROUPS.includes(currentGroupName)) {
    groupsToRemove.push(currentGroupName);
  }

  for (const gName of groupsToRemove) {
    let start = -1;
    let end = -1;
    let inPG = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed === 'proxy-groups:') {
        inPG = true;
        continue;
      }

      if (inPG) {
        if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
          if (start !== -1 && end === -1) end = i;
          break;
        }

        if (trimmed.startsWith('- name:')) {
          const name = trimmed.replace(/- name:\s*/, '').replace(/['"]/g, '').trim();
          if (name === gName) {
            start = i;
          } else if (start !== -1 && end === -1) {
            end = i;
            break;
          }
        }
      }
    }

    if (start !== -1) {
      if (end === -1) end = lines.length;
      lines.splice(start, end - start);
    }

    let inProxiesSection = false;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith('proxies:')) {
        inProxiesSection = true;
        i++;
        continue;
      }

      if (inProxiesSection) {
        if (trimmed.startsWith('- name:') || (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-'))) {
          inProxiesSection = false;
        } else if (trimmed.startsWith('-')) {
          const proxyInList = trimmed.substring(1).trim().replace(/['"]/g, '');
          if (proxyInList === gName) {
            lines.splice(i, 1);
            continue;
          }
        }
      }
      i++;
    }
  }
}

function sortProxiesInAutoBestInLines(lines, orderedCardNames) {
  let inProxyGroups = false;
  let inAutoBest = false;
  let inProxies = false;
  let proxiesStartIndex = -1;
  let proxyItems = [];

  const flushSort = () => {
    if (proxiesStartIndex !== -1 && proxyItems.length > 0) {
      proxyItems.sort((a, b) => {
        const idxA = orderedCardNames.indexOf(a.name);
        const idxB = orderedCardNames.indexOf(b.name);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return 0;
      });
      const sortedLines = proxyItems.map(item => item.line);
      lines.splice(proxiesStartIndex, proxyItems.length, ...sortedLines);
    }
    proxiesStartIndex = -1;
    proxyItems = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === 'proxy-groups:') {
      inProxyGroups = true;
      i++;
      continue;
    }

    if (inProxyGroups && line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
      flushSort();
      break;
    }

    if (inProxyGroups) {
      if (trimmed.startsWith('- name:')) {
        flushSort();
        const gName = trimmed.replace(/- name:\s*/, '').replace(/['"]/g, '').trim();
        inAutoBest = (gName === '🚀Auto-Best');
        inProxies = false;
      } else if (inAutoBest && trimmed.startsWith('proxies:')) {
        flushSort();
        inProxies = true;
        proxiesStartIndex = i + 1;
      } else if (inAutoBest && inProxies && trimmed.startsWith('-')) {
        const pName = trimmed.substring(1).trim().replace(/['"]/g, '');
        proxyItems.push({ name: pName, line });
      } else if (inAutoBest && inProxies && (!line.startsWith(' ') || trimmed.startsWith('type:') || trimmed.startsWith('url:'))) {
        flushSort();
        inProxies = false;
      }
    }
    i++;
  }
  flushSort();
}

// Автоматическая синхронизация собственных прокси-групп для ВСЕХ подписок без дубликатов
function syncAllProviderGroupsInConfig(yamlText) {
  const providers = getProxyProvidersFromConfig(yamlText);
  let lines = yamlText.split(/\r?\n/);
  const orderedCardNames = providers.map(p => getGroupCardNameForProvider(p.name));

  providers.forEach(p => {
    const providerName = p.name;
    const groupCardName = getGroupCardNameForProvider(providerName);

    ensureProviderGroupInLines(lines, providerName);

    injectProxyIntoGroup(lines, 'GLOBAL', groupCardName);
    injectProxyIntoGroup(lines, '🚀Auto-Best', groupCardName);
  });

  sortProxiesInAutoBestInLines(lines, orderedCardNames);

  return lines.join('\n');
}

function ensureProviderGroupInLines(lines, providerName) {
  const ignoreGroupNames = ['GLOBAL', 'DIRECT', 'REJECT', '🚀Auto-Best', '⚙️Manual 1', '⚙️Manual 2', '⚙️Manual 3'];
  let hasGroup = false;
  let inProxyGroups = false;
  let currentGroupName = '';
  let groupUses = [];

  const checkCurrentGroup = () => {
    if (currentGroupName && !ignoreGroupNames.includes(currentGroupName)) {
      if (groupUses.includes(providerName)) {
        hasGroup = true;
      }
    }
  };

  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = line.trim();

    if (trimmed === 'proxy-groups:') {
      inProxyGroups = true;
      idx++;
      continue;
    }

    if (inProxyGroups && line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
      checkCurrentGroup();
      inProxyGroups = false;
    }

    if (inProxyGroups) {
      if (trimmed.startsWith('- name:')) {
        checkCurrentGroup();
        currentGroupName = trimmed.replace(/- name:\s*/, '').replace(/['"]/g, '').trim();
        groupUses = [];
      } else if (trimmed.startsWith('use:')) {
        let j = idx + 1;
        while (j < lines.length) {
          const uLine = lines[j].trim();
          if (uLine.startsWith('-')) {
            const uName = uLine.substring(1).trim().replace(/['"]/g, '');
            groupUses.push(uName);
          } else {
            break;
          }
          j++;
        }
      }
    }
    idx++;
  }
  checkCurrentGroup();

  const groupCardName = getGroupCardNameForProvider(providerName);

  if (!hasGroup) {
    updateProviderGroupInLines(lines, providerName, { groupType: 'url-test' });
  }

  injectProxyIntoGroup(lines, 'GLOBAL', groupCardName);
  injectProxyIntoGroup(lines, '🚀Auto-Best', groupCardName);
}

// Переупорядочивание подписок (proxy-providers) и их вызовов (use:) во всех группах
function reorderProvidersInConfig(yamlText, orderNames) {
  const lines = yamlText.split(/\r?\n/);
  
  // 1. Извлекаем текущие блоки proxy-providers
  let inProviders = false;
  let providerBlocks = {};
  let currentProv = null;
  let currentLines = [];
  let providersStartIndex = -1;
  let providersEndIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === 'proxy-providers:') {
      inProviders = true;
      providersStartIndex = i;
      continue;
    }

    if (inProviders) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
        providersEndIndex = i;
        if (currentProv) providerBlocks[currentProv] = currentLines;
        inProviders = false;
        break;
      }

      if (line.startsWith('  ') && !line.startsWith('    ') && trimmed.endsWith(':')) {
        if (currentProv) providerBlocks[currentProv] = currentLines;
        currentProv = trimmed.slice(0, -1).trim();
        currentLines = [line];
        continue;
      }

      if (currentProv) {
        currentLines.push(line);
      }
    }
  }

  if (inProviders && currentProv) {
    providerBlocks[currentProv] = currentLines;
    if (providersEndIndex === -1) providersEndIndex = lines.length;
  }

  if (providersStartIndex !== -1 && Object.keys(providerBlocks).length > 0) {
    let newProviderLines = [];
    orderNames.forEach(name => {
      if (providerBlocks[name]) {
        newProviderLines.push(...providerBlocks[name]);
        delete providerBlocks[name];
      }
    });
    Object.values(providerBlocks).forEach(blk => newProviderLines.push(...blk));

    lines.splice(providersStartIndex + 1, providersEndIndex - (providersStartIndex + 1), ...newProviderLines);
  }

  // 2. Сортируем списки use: во всех прокси-группах в соответствии с orderNames
  let inProxyGroups = false;
  let inUse = false;
  let useStartIndex = -1;
  let useItems = [];

  const flushUseSort = () => {
    if (useStartIndex !== -1 && useItems.length > 0) {
      useItems.sort((a, b) => {
        const idxA = orderNames.indexOf(a.name);
        const idxB = orderNames.indexOf(b.name);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return 0;
      });
      const sortedLines = useItems.map(item => item.line);
      lines.splice(useStartIndex, useItems.length, ...sortedLines);
    }
    useStartIndex = -1;
    useItems = [];
  };

  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = line.trim();

    if (trimmed === 'proxy-groups:') {
      inProxyGroups = true;
      idx++;
      continue;
    }

    if (inProxyGroups && line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
      flushUseSort();
      inProxyGroups = false;
    }

    if (inProxyGroups) {
      if (trimmed.startsWith('- name:')) {
        flushUseSort();
        inUse = false;
      } else if (trimmed.startsWith('use:')) {
        flushUseSort();
        inUse = true;
        useStartIndex = idx + 1;
      } else if (inUse && trimmed.startsWith('-')) {
        const name = trimmed.substring(1).trim().replace(/['"]/g, '');
        useItems.push({ name, line });
      } else if (inUse && (!line.startsWith(' ') || trimmed.startsWith('proxies:') || trimmed.startsWith('type:'))) {
        flushUseSort();
        inUse = false;
      }
    }
    idx++;
  }
  flushUseSort();

  return lines.join('\n');
}

function extractProxiesFromYaml(yamlText) {
  if (!yamlText) return [];
  const lines = yamlText.split(/\r?\n/);
  let inProxies = false;
  let inRealityOpts = false;
  let inGrpcOpts = false;
  let inWsOpts = false;
  const proxies = [];
  let currentProxy = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === 'proxies:') {
      inProxies = true;
      continue;
    }
    if (inProxies) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
        break;
      }
      if (trimmed.startsWith('- name:') || (line.startsWith('  -') && line.includes('name:'))) {
        if (currentProxy && currentProxy.name) proxies.push(currentProxy);
        currentProxy = {};
        inRealityOpts = false;
        inGrpcOpts = false;
        inWsOpts = false;
        const colon = trimmed.indexOf(':');
        const key = trimmed.substring(trimmed.startsWith('-') ? 1 : 0, colon).replace(/^-/, '').trim();
        const val = trimmed.substring(colon + 1).trim().replace(/^['"]|['"]$/g, '');
        currentProxy[key] = val;
        continue;
      }
      if (currentProxy && line.startsWith('    ') && !line.startsWith('      ')) {
        const colon = trimmed.indexOf(':');
        if (colon !== -1) {
          const key = trimmed.substring(0, colon).trim();
          const rawVal = trimmed.substring(colon + 1).trim();
          if (key === 'reality-opts') {
            inRealityOpts = true;
            inGrpcOpts = false;
            inWsOpts = false;
            currentProxy['reality-opts'] = {};
            continue;
          } else if (key === 'grpc-opts') {
            inGrpcOpts = true;
            inRealityOpts = false;
            inWsOpts = false;
            currentProxy['grpc-opts'] = {};
            continue;
          } else if (key === 'ws-opts') {
            inWsOpts = true;
            inRealityOpts = false;
            inGrpcOpts = false;
            currentProxy['ws-opts'] = {};
            continue;
          } else {
            inRealityOpts = false;
            inGrpcOpts = false;
            inWsOpts = false;
            let val = rawVal.replace(/^['"]|['"]$/g, '');
            if (val === 'true') val = true;
            else if (val === 'false') val = false;
            else if (/^\d+$/.test(val)) val = parseInt(val, 10);
            currentProxy[key] = val;
          }
        }
      }
      if (currentProxy && line.startsWith('      ')) {
        const colon = trimmed.indexOf(':');
        if (colon !== -1) {
          const key = trimmed.substring(0, colon).trim();
          let val = trimmed.substring(colon + 1).trim().replace(/^['"]|['"]$/g, '');
          if (val === 'true') val = true;
          else if (val === 'false') val = false;
          else if (/^\d+$/.test(val)) val = parseInt(val, 10);

          if (inRealityOpts && currentProxy['reality-opts']) {
            currentProxy['reality-opts'][key] = val;
          } else if (inGrpcOpts && currentProxy['grpc-opts']) {
            currentProxy['grpc-opts'][key] = val;
          } else if (inWsOpts && currentProxy['ws-opts']) {
            currentProxy['ws-opts'][key] = val;
          }
        }
      }
    }
  }
  if (currentProxy && currentProxy.name) proxies.push(currentProxy);
  return proxies;
}

function serializeProxyToUri(p) {
  if (!p || !p.type) return '';
  if (p.type === 'vless') {
    let uri = `vless://${p.uuid}@${p.server}:${p.port}?type=${p.network || 'tcp'}`;
    if (p.tls) {
      if (p['reality-opts']) {
        uri += `&security=reality&pbk=${p['reality-opts']['public-key'] || ''}&sid=${p['reality-opts']['short-id'] || ''}`;
      } else {
        uri += `&security=tls`;
      }
    }
    if (p.flow) uri += `&flow=${p.flow}`;
    if (p.servername) uri += `&sni=${p.servername}`;
    if (p['client-fingerprint']) uri += `&fp=${p['client-fingerprint']}`;
    uri += `#${encodeURIComponent(p.name || 'Proxy')}`;
    return uri;
  }
  if (p.type === 'ss') {
    const userinfo = Buffer.from(`${p.cipher}:${p.password}`).toString('base64');
    return `ss://${userinfo}@${p.server}:${p.port}#${encodeURIComponent(p.name || 'Proxy')}`;
  }
  if (p.type === 'trojan') {
    return `trojan://${p.password}@${p.server}:${p.port}?security=${p.tls ? 'tls' : 'none'}#${encodeURIComponent(p.name || 'Proxy')}`;
  }
  return '';
}

module.exports = {
  parseProxyUri,
  parseV2RayOrSingboxJson,
  serializeProxyToYaml,
  serializeProxyToUri,
  extractProxiesFromYaml,
  injectProxyIntoConfig,
  injectProxyIntoGroup,
  getProxyProvidersFromConfig,
  updateProviderInConfig,
  addProviderToConfig,
  deleteProviderFromConfig,
  purgeProviderFromConfig,
  addUseToGroupInLines,
  removeUseFromGroupsInLines,
  cleanupEmptyGroupsInLines,
  ensureProviderGroupInLines,
  syncAllProviderGroupsInConfig,
  reorderProvidersInConfig,
  getGroupCardNameForProvider,
  getGroupForProviderInLines,
  updateProviderGroupInLines,
  buildProviderHealthCheckLines
};
