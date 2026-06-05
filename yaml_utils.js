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
  removeUseFromGroupsInLines
};
