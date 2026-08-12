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

// Чтение провайдеров подписок из config.yaml
function getProxyProvidersFromConfig(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  let inProviders = false;
  const providers = [];
  let currentProvider = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed === 'proxy-providers:') {
      inProviders = true;
      continue;
    }
    
    if (inProviders) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
        inProviders = false;
        break;
      }
      
      if (line.startsWith('  ') && !line.startsWith('    ') && trimmed.endsWith(':')) {
        const nameVal = trimmed.slice(0, -1).trim();
        currentProvider = { name: nameVal };
        providers.push(currentProvider);
        continue;
      }
      
      if (currentProvider && line.startsWith('    ') && !line.startsWith('      ')) {
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex !== -1) {
          const key = trimmed.substring(0, colonIndex).trim();
          const val = trimmed.substring(colonIndex + 1).trim().replace(/^['"]|['"]$/g, '');
          if (key === 'url') currentProvider.url = val;
          if (key === 'interval') currentProvider.interval = parseInt(val, 10);
          if (key === 'path') currentProvider.path = val;
        }
      }
    }
  }
  return providers;
}

// Редактирование существующего провайдера в config.yaml
function updateProviderInConfig(yamlText, name, url, interval) {
  const lines = yamlText.split(/\r?\n/);
  let inProviders = false;
  let currentProvider = null;
  let urlIndex = -1;
  let intervalIndex = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed === 'proxy-providers:') {
      inProviders = true;
      continue;
    }
    
    if (inProviders) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
        break;
      }
      
      if (line.startsWith('  ') && !line.startsWith('    ') && trimmed.endsWith(':')) {
        currentProvider = trimmed.slice(0, -1).trim();
        continue;
      }
      
      if (currentProvider === name && line.startsWith('    ') && !line.startsWith('      ')) {
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex !== -1) {
          const key = trimmed.substring(0, colonIndex).trim();
          if (key === 'url') urlIndex = i;
          if (key === 'interval') intervalIndex = i;
        }
      }
    }
  }
  
  if (urlIndex !== -1) {
    lines[urlIndex] = `    url: "${url}"`;
  }
  if (intervalIndex !== -1) {
    lines[intervalIndex] = `    interval: ${interval}`;
  }
  
  return lines.join('\n');
}

// Добавление нового провайдера подписки в config.yaml
function addProviderToConfig(yamlText, name, url, interval) {
  const lines = yamlText.split(/\r?\n/);
  const providersIndex = lines.findIndex(line => line.trim() === 'proxy-providers:');
  if (providersIndex === -1) {
    throw new Error('Секция proxy-providers: не найдена в файле конфигурации');
  }
  
  const providerYaml = [
    `  ${name}:`,
    `    type: http`,
    `    url: "${url}"`,
    `    interval: ${interval}`,
    `    path: ./proxy_providers/${name.toLowerCase()}.yaml`,
    `    health-check:`,
    `      enable: true`,
    `      url: http://www.gstatic.com/generate_204`,
    `      interval: 300`
  ];
  
  lines.splice(providersIndex + 1, 0, ...providerYaml);
  return lines.join('\n');
}

// Удаление провайдера подписки из config.yaml
function deleteProviderFromConfig(yamlText, name) {
  const lines = yamlText.split(/\r?\n/);
  let inProviders = false;
  let currentProvider = null;
  let startIndex = -1;
  let endIndex = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed === 'proxy-providers:') {
      inProviders = true;
      continue;
    }
    
    if (inProviders) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
        break;
      }
      
      if (line.startsWith('  ') && !line.startsWith('    ') && trimmed.endsWith(':')) {
        if (currentProvider === name) {
          endIndex = i;
          break;
        }
        currentProvider = trimmed.slice(0, -1).trim();
        if (currentProvider === name) {
          startIndex = i;
        }
        continue;
      }
    }
  }
  
  if (startIndex !== -1) {
    if (endIndex === -1) {
      endIndex = lines.length;
      for (let i = startIndex + 1; i < lines.length; i++) {
        if (lines[i].length > 0 && !lines[i].startsWith(' ')) {
          endIndex = i;
          break;
        }
      }
    }
    lines.splice(startIndex, endIndex - startIndex);
  }
  
  return lines.join('\n');
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

// Автоматическая синхронизация собственных прокси-групп для ВСЕХ подписок без дубликатов
function syncAllProviderGroupsInConfig(yamlText) {
  const providers = getProxyProvidersFromConfig(yamlText);
  let lines = yamlText.split(/\r?\n/);
  
  const ignoreGroupNames = ['GLOBAL', 'DIRECT', 'REJECT', '🚀Auto-Best', '⚙️Manual 1', '⚙️Manual 2', '⚙️Manual 3'];

  providers.forEach(p => {
    const providerName = p.name;
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

    if (!hasGroup) {
      const groupsIndex = lines.findIndex(line => line.trim() === 'proxy-groups:');
      if (groupsIndex !== -1) {
        const groupCardName = `⚡ ${providerName}`;
        const newGroupLines = [
          `  - name: '${groupCardName}'`,
          `    type: select`,
          `    use:`,
          `      - ${providerName}`,
          ``
        ];
        lines.splice(groupsIndex + 1, 0, ...newGroupLines);
        
        // Внедряем карточку группы в GLOBAL и подписку в Auto-Best
        injectProxyIntoGroup(lines, 'GLOBAL', groupCardName);
        addUseToGroupInLines(lines, '🚀Auto-Best', providerName);
      }
    }
  });

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

  if (!hasGroup) {
    const groupsIndex = lines.findIndex(line => line.trim() === 'proxy-groups:');
    if (groupsIndex !== -1) {
      const groupCardName = `⚡ ${providerName}`;
      const newGroupLines = [
        `  - name: '${groupCardName}'`,
        `    type: select`,
        `    use:`,
        `      - ${providerName}`,
        ``
      ];
      lines.splice(groupsIndex + 1, 0, ...newGroupLines);
      injectProxyIntoGroup(lines, 'GLOBAL', groupCardName);
    }
  }
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

module.exports = {
  parseProxyUri,
  serializeProxyToYaml,
  injectProxyIntoConfig,
  injectProxyIntoGroup,
  getProxyProvidersFromConfig,
  updateProviderInConfig,
  addProviderToConfig,
  deleteProviderFromConfig,
  addUseToGroupInLines,
  removeUseFromGroupsInLines,
  cleanupEmptyGroupsInLines,
  ensureProviderGroupInLines,
  syncAllProviderGroupsInConfig,
  reorderProvidersInConfig
};
