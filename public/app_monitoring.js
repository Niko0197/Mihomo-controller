// public/app_monitoring.js

// Global state variables for streams and interval timers
let trafficAbortController = null;
let logsAbortController = null;
let connectionsInterval = null;
let connectionsSilentMode = false;

let currentTab = 'leak';
let activeLogLevel = 'info';
let userScrolledUpMap = {
  debug: false,
  info: false,
  warning: false,
  error: false
};

let trafficChart = null;
const chartDataPointsLimit = 60;
let trafficDownloadHistory = Array(chartDataPointsLimit).fill(0);
let trafficUploadHistory = Array(chartDataPointsLimit).fill(0);
let trafficLabels = Array(chartDataPointsLimit).fill('');

// Volumes tracking state
let activeConnectionsMap = new Map();
let vpnDownloadAccum = 0;
let vpnUploadAccum = 0;
let directDownloadAccum = 0;
let directUploadAccum = 0;

// Last bytes map for calculating per-connection speed
let lastConnBytesMap = new Map();

// Helper to format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0.00 MB';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i === 0) return bytes + ' B';
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper to format speeds
function formatSpeed(bytesPerSec) {
  if (bytesPerSec === 0) return '0 KB/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  if (i === 0) return bytesPerSec + ' B/s';
  return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// --- Dynamic Tab Switching Hook ---
// Wrap the original switchTab function to start/stop streams accordingly
const originalSwitchTab = window.switchTab;
window.switchTab = function(tabId) {
  currentTab = tabId;
  // Call original logic to transition active classes
  originalSwitchTab(tabId);
  
  // Update connections polling mode based on current tab
  if (tabId === 'connections') {
    startConnectionsPolling(false); // Active rendering
  } else {
    startConnectionsPolling(true); // Silent background polling for stats
  }
  
  // If user switched to traffic tab, initialize and refresh the chart immediately
  if (tabId === 'traffic') {
    const speedDownEl = document.getElementById('speed-download');
    const speedUpEl = document.getElementById('speed-upload');
    const lastDown = trafficDownloadHistory[trafficDownloadHistory.length - 1] || 0;
    const lastUp = trafficUploadHistory[trafficUploadHistory.length - 1] || 0;
    
    if (speedDownEl) speedDownEl.textContent = formatSpeed(lastDown);
    if (speedUpEl) speedUpEl.textContent = formatSpeed(lastUp);
    
    if (!trafficChart) {
      initTrafficChart();
    }
    if (trafficChart) {
      trafficChart.update('none');
    }
  } else if (tabId === 'logs') {
    reRenderLogs();
  }
};

// --- Streaming HTTP Reader using Fetch + ReadableStream ---
async function readHttpStream(url, onChunk, abortSignal) {
  try {
    const response = await fetch(url, { signal: abortSignal });
    if (!response.ok) throw new Error('Stream request returned HTTP status: ' + response.status);
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = '';
    
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      
      // Store the last incomplete line back in buffer
      buffer = lines.pop();
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const data = JSON.parse(line);
            onChunk(data);
          } catch (e) {
            console.error('Failed to parse line:', line, e);
          }
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Streaming error on ' + url + ':', err.message);
    }
  }
}

// --- 1. Real-time Traffic Graph Tab ---
function initTrafficChart() {
  if (trafficChart) return;
  
  const canvas = document.getElementById('traffic-speed-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  trafficChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: trafficLabels,
      datasets: [
        {
          label: 'Скачивание (Download)',
          data: trafficDownloadHistory,
          borderColor: '#a8c7fa',
          backgroundColor: 'rgba(168, 199, 250, 0.04)',
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 0
        },
        {
          label: 'Отдача (Upload)',
          data: trafficUploadHistory,
          borderColor: '#3ddc84',
          backgroundColor: 'rgba(61, 220, 132, 0.04)',
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          labels: {
            color: '#e3e2e6',
            font: { family: 'Inter', weight: '500' }
          }
        },
        tooltip: {
          callbacks: {
            title: function() {
              return ''; // Hide X-axis index/time title as it's not relevant here
            },
            label: function(context) {
              let label = context.dataset.label || '';
              if (label) {
                label += ': ';
              }
              if (context.parsed.y !== null) {
                label += formatSpeed(context.parsed.y);
              }
              return label;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { display: false }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            color: '#9094a6',
            font: { family: 'monospace', size: 10 },
            callback: function(value) {
              return formatSpeed(value);
            }
          }
        }
      }
    }
  });
}

function startTrafficStream() {
  if (trafficAbortController) return; // Stream is already active in background
  
  const statusEl = document.getElementById('traffic-status');
  if (statusEl) statusEl.textContent = 'Подключение...';
  
  trafficAbortController = new AbortController();
  
  // We also poll connections in the background to calculate volume stats
  startConnectionsPolling(true); // silent background poll
  
  readHttpStream('/api/xkeen/traffic', (data) => {
    if (statusEl) statusEl.textContent = 'Поток активен';
    
    // Shift history values
    trafficDownloadHistory.shift();
    trafficDownloadHistory.push(data.down);
    trafficUploadHistory.shift();
    trafficUploadHistory.push(data.up);
    
    // Update labels and chart only if currently viewing Traffic tab
    if (currentTab === 'traffic') {
      const speedDownEl = document.getElementById('speed-download');
      const speedUpEl = document.getElementById('speed-upload');
      if (speedDownEl) speedDownEl.textContent = formatSpeed(data.down);
      if (speedUpEl) speedUpEl.textContent = formatSpeed(data.up);
      
      if (!trafficChart) {
        initTrafficChart();
      }
      if (trafficChart) {
        trafficChart.update('none'); // Update without transition animation
      }
    }
  }, trafficAbortController.signal);
}

function stopTrafficStream() {
  if (trafficAbortController) {
    trafficAbortController.abort();
    trafficAbortController = null;
  }
  const statusEl = document.getElementById('traffic-status');
  if (statusEl) statusEl.textContent = 'Поток приостановлен';
}

// --- 2. Active Connections Table ---
function startConnectionsPolling(silent = false) {
  connectionsSilentMode = silent;
  stopConnectionsPolling();
  
  if (!silent) {
    const tbody = document.getElementById('connections-list');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">Инициализация списка соединений...</td></tr>';
  }
  
  loadConnections();
  connectionsInterval = setInterval(loadConnections, 2000);
}

function stopConnectionsPolling() {
  if (connectionsInterval) {
    clearInterval(connectionsInterval);
    connectionsInterval = null;
  }
}

async function loadConnections() {
  try {
    const res = await fetch('/api/xkeen/connections');
    if (!res.ok) throw new Error('Failed to fetch active connections');
    const data = await res.json();
    const connections = data.connections || [];
    
    // Aggregate VPN vs DIRECT traffic volumes
    updateTrafficVolumes(connections);
    
    // If silent mode is active, do not render table rows or connection count to save CPU
    if (connectionsSilentMode) return;
    
    // Render connection count
    const countEl = document.getElementById('connections-count');
    if (countEl) countEl.textContent = `Всего: ${connections.length}`;
    
    // Render table rows
    renderConnectionsTable(connections);
  } catch (err) {
    console.error('Error loading connections:', err.message);
  }
}

function updateTrafficVolumes(connectionsList) {
  const currentIds = new Set();
  
  for (const conn of connectionsList) {
    currentIds.add(conn.id);
    // Determine if connection goes direct
    const isDirect = conn.chains.includes('DIRECT') || (conn.chains.length > 0 && conn.chains[conn.chains.length - 1].toLowerCase() === 'direct');
    
    const lastState = activeConnectionsMap.get(conn.id);
    if (lastState) {
      const downDiff = Math.max(0, conn.download - lastState.download);
      const upDiff = Math.max(0, conn.upload - lastState.upload);
      
      if (isDirect) {
        directDownloadAccum += downDiff;
        directUploadAccum += upDiff;
      } else {
        vpnDownloadAccum += downDiff;
        vpnUploadAccum += upDiff;
      }
    } else {
      // First time seeing this connection: count starting bytes
      if (isDirect) {
        directDownloadAccum += conn.download;
        directUploadAccum += conn.upload;
      } else {
        vpnDownloadAccum += conn.download;
        vpnUploadAccum += conn.upload;
      }
    }
    
    activeConnectionsMap.set(conn.id, {
      download: conn.download,
      upload: conn.upload,
      isDirect
    });
  }
  
  // Remove dead connections
  for (const id of activeConnectionsMap.keys()) {
    if (!currentIds.has(id)) {
      activeConnectionsMap.delete(id);
    }
  }
  
  // Render calculated traffic volume metrics
  const vpnBytes = document.getElementById('vol-vpn-bytes');
  const directBytes = document.getElementById('vol-direct-bytes');
  
  if (vpnBytes) vpnBytes.textContent = formatBytes(vpnDownloadAccum + vpnUploadAccum);
  if (directBytes) directBytes.textContent = formatBytes(directDownloadAccum + directUploadAccum);
}

function renderConnectionsTable(connections) {
  const tbody = document.getElementById('connections-list');
  if (!tbody) return;
  
  const searchInput = document.getElementById('conn-search-box');
  const query = searchInput ? searchInput.value.toLowerCase() : '';
  
  const filtered = connections.filter(c => {
    const host = (c.metadata.host || c.metadata.destinationIP || '').toLowerCase();
    const srcIp = (c.metadata.sourceIP || '').toLowerCase();
    const rule = (c.rule || '').toLowerCase();
    const chain = c.chains.join(' ').toLowerCase();
    return host.includes(query) || srcIp.includes(query) || rule.includes(query) || chain.includes(query);
  });
  
  tbody.innerHTML = '';
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Активные соединения отсутствуют</td></tr>';
    return;
  }
  
  const now = Date.now();
  const newBytesMap = new Map();
  
  filtered.forEach(c => {
    const tr = document.createElement('tr');
    
    // Source
    const tdSrc = document.createElement('td');
    tdSrc.textContent = c.metadata.sourceIP + ':' + c.metadata.sourcePort;
    
    // Destination
    const tdDest = document.createElement('td');
    tdDest.style.maxWidth = '280px';
    tdDest.style.overflow = 'hidden';
    tdDest.style.textOverflow = 'ellipsis';
    tdDest.style.whiteSpace = 'nowrap';
    const destText = (c.metadata.host || c.metadata.destinationIP) + ':' + c.metadata.destinationPort;
    tdDest.textContent = destText;
    tdDest.title = destText;
    
    // Protocol
    const tdProto = document.createElement('td');
    tdProto.innerHTML = `<span class="route-badge">${c.metadata.network.toUpperCase()}</span>`;
    
    // Rule
    const tdRule = document.createElement('td');
    tdRule.style.maxWidth = '280px';
    tdRule.style.overflow = 'hidden';
    tdRule.style.textOverflow = 'ellipsis';
    tdRule.style.whiteSpace = 'nowrap';
    const ruleText = c.rule + (c.rulePayload ? ' (' + c.rulePayload + ')' : '');
    tdRule.textContent = ruleText;
    tdRule.title = ruleText;
    
    // Chains
    const tdChains = document.createElement('td');
    tdChains.style.maxWidth = '280px';
    tdChains.style.overflow = 'hidden';
    tdChains.style.textOverflow = 'ellipsis';
    tdChains.style.whiteSpace = 'nowrap';
    tdChains.style.fontSize = '0.9rem';
    const chainsText = c.chains.join(' ➔ ');
    tdChains.textContent = chainsText;
    tdChains.title = chainsText;
    
    // Traffic & Speed calculation
    const tdTraffic = document.createElement('td');
    const totalBytes = c.download + c.upload;
    let speedText = '';
    
    const prev = lastConnBytesMap.get(c.id);
    if (prev) {
      const timeDiff = (now - prev.time) / 1000;
      if (timeDiff > 0) {
        const downDiff = c.download - prev.download;
        const upDiff = c.upload - prev.upload;
        const speed = (downDiff + upDiff) / timeDiff;
        if (speed > 0) {
          speedText = ` (⚡ ${formatSpeed(speed)})`;
        }
      }
    }
    newBytesMap.set(c.id, { download: c.download, upload: c.upload, time: now });
    tdTraffic.textContent = formatBytes(totalBytes) + speedText;
    
    // Action: Terminate connection
    const tdAction = document.createElement('td');
    tdAction.style.textAlign = 'center';
    const btnClose = document.createElement('button');
    btnClose.className = 'btn';
    btnClose.style.padding = '4px 10px';
    btnClose.style.fontSize = '0.8rem';
    btnClose.style.background = 'rgba(239, 68, 68, 0.1)';
    btnClose.style.borderColor = 'rgba(239, 68, 68, 0.2)';
    btnClose.style.color = 'var(--danger)';
    btnClose.textContent = 'Разорвать';
    btnClose.onclick = async function() {
      btnClose.disabled = true;
      btnClose.textContent = '...';
      try {
        const res = await fetch('/api/xkeen/connections/' + encodeURIComponent(c.id), { method: 'DELETE' });
        if (res.ok) {
          showToast('Соединение успешно закрыто!');
          loadConnections();
        } else {
          showToast('Сбой удаления соединения', 'error');
          btnClose.disabled = false;
          btnClose.textContent = 'Разорвать';
        }
      } catch (e) {
        showToast('Ошибка сети', 'error');
        btnClose.disabled = false;
        btnClose.textContent = 'Разорвать';
      }
    };
    tdAction.appendChild(btnClose);
    
    tr.appendChild(tdSrc);
    tr.appendChild(tdDest);
    tr.appendChild(tdProto);
    tr.appendChild(tdRule);
    tr.appendChild(tdChains);
    tr.appendChild(tdTraffic);
    tr.appendChild(tdAction);
    
    tbody.appendChild(tr);
  });
  
  lastConnBytesMap = newBytesMap;
}

// Bind connections tab actions
const btnRefreshConn = document.getElementById('btn-refresh-connections');
if (btnRefreshConn) {
  btnRefreshConn.onclick = function() {
    loadConnections();
  };
}

const btnCloseAllConn = document.getElementById('btn-close-all-connections');
if (btnCloseAllConn) {
  btnCloseAllConn.onclick = async function() {
    if (!confirm('Вы действительно хотите разорвать абсолютно все текущие сетевые соединения?')) return;
    const btn = this;
    btn.disabled = true;
    btn.textContent = 'Закрываем...';
    try {
      const res = await fetch('/api/xkeen/connections', { method: 'DELETE' });
      if (res.ok) {
        showToast('Все соединения разорваны!');
        loadConnections();
      } else {
        showToast('Не удалось закрыть все соединения', 'error');
      }
    } catch (e) {
      showToast('Ошибка сети', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '❌ Разорвать все';
    }
  };
}

const connSearchBox = document.getElementById('conn-search-box');
if (connSearchBox) {
  connSearchBox.oninput = function() {
    loadConnections();
  };
}


// --- 3. Core Logs Terminal (Persistent background streaming) ---
let logsCache = [];

function startLogsStream() {
  if (logsAbortController) return; // Stream is already active in background
  
  logsAbortController = new AbortController();
  
  // Always query with 'debug' level to capture all events in background, then filter client-side
  readHttpStream('/api/xkeen/logs?level=debug', (logObj) => {
    // Generate/cache timestamp when received so it stays static
    if (!logObj.timeStr) {
      logObj.timeStr = new Date().toLocaleTimeString('ru-RU');
    }
    
    logsCache.push(logObj);
    if (logsCache.length > 1000) logsCache.shift(); // Keep cache up to 1000 lines
    
    // Append to DOM immediately only if user is currently looking at the Logs tab
    if (currentTab === 'logs') {
      renderLogLine(logObj);
    }
  }, logsAbortController.signal);
}

function stopLogsStream() {
  if (logsAbortController) {
    logsAbortController.abort();
    logsAbortController = null;
  }
}

function renderLogLine(logObj) {
  if (!logObj.timeStr) {
    logObj.timeStr = new Date().toLocaleTimeString('ru-RU');
  }

  const levels = ['debug', 'info', 'warning', 'error'];
  const logType = logObj.type.toLowerCase();
  const currentIdx = levels.indexOf(logType);
  if (currentIdx === -1) return;
  
  // Append to all consoles that matching log levels should show up in (currentIdx >= targetIdx)
  levels.forEach(level => {
    const targetIdx = levels.indexOf(level);
    if (currentIdx < targetIdx) return;
    
    const consoleEl = document.getElementById(`log-console-${level}`);
    if (!consoleEl) return;
    
    // Keyword filter
    const queryInput = document.getElementById('log-search-box');
    const query = queryInput ? queryInput.value.toLowerCase() : '';
    if (query && !logObj.payload.toLowerCase().includes(query)) return;
    
    const line = document.createElement('div');
    line.className = 'console-line log-' + logType;
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'console-line-time';
    timeSpan.textContent = logObj.timeStr;
    
    const payloadSpan = document.createElement('span');
    payloadSpan.textContent = `[${logObj.type.toUpperCase()}] ${logObj.payload}`;
    
    line.appendChild(timeSpan);
    line.appendChild(payloadSpan);
    consoleEl.appendChild(line);
    
    // Cap console DOM nodes
    while (consoleEl.children.length > 1000) {
      consoleEl.removeChild(consoleEl.firstChild);
    }
    
    // Scroll to bottom if autoscroll is enabled for this level
    if (!userScrolledUpMap[level]) {
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }
  });
}

function reRenderLogs() {
  const levels = ['debug', 'info', 'warning', 'error'];
  levels.forEach(level => {
    const consoleEl = document.getElementById(`log-console-${level}`);
    if (!consoleEl) return;
    consoleEl.innerHTML = '';
  });
  
  // Re-populate all consoles from cache
  logsCache.forEach(logObj => {
    const logType = logObj.type.toLowerCase();
    const currentIdx = levels.indexOf(logType);
    if (currentIdx === -1) return;
    
    levels.forEach(level => {
      const targetIdx = levels.indexOf(level);
      if (currentIdx < targetIdx) return;
      
      const consoleEl = document.getElementById(`log-console-${level}`);
      if (!consoleEl) return;
      
      // Keyword filter
      const queryInput = document.getElementById('log-search-box');
      const query = queryInput ? queryInput.value.toLowerCase() : '';
      if (query && !logObj.payload.toLowerCase().includes(query)) return;
      
      const line = document.createElement('div');
      line.className = 'console-line log-' + logType;
      
      const timeSpan = document.createElement('span');
      timeSpan.className = 'console-line-time';
      timeSpan.textContent = logObj.timeStr;
      
      const payloadSpan = document.createElement('span');
      payloadSpan.textContent = `[${logObj.type.toUpperCase()}] ${logObj.payload}`;
      
      line.appendChild(timeSpan);
      line.appendChild(payloadSpan);
      consoleEl.appendChild(line);
    });
  });
  
  // Focus scrolling when tab selected/rendered
  levels.forEach(level => {
    const consoleEl = document.getElementById(`log-console-${level}`);
    if (!consoleEl) return;
    if (!userScrolledUpMap[level]) {
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }
  });

  // Update autoscroll checkbox to match the active log level scroll state
  const autoScrollCheckbox = document.getElementById('log-autoscroll');
  if (autoScrollCheckbox) {
    autoScrollCheckbox.checked = !userScrolledUpMap[activeLogLevel];
  }
}

function switchLogLevel(level) {
  activeLogLevel = level;
  
  // Update button active classes
  const buttons = document.querySelectorAll('.log-level-btn');
  buttons.forEach(btn => {
    if (btn.dataset.level === level) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  
  // Hide all terminals except the active one
  const levels = ['debug', 'info', 'warning', 'error'];
  levels.forEach(l => {
    const consoleEl = document.getElementById(`log-console-${l}`);
    if (consoleEl) {
      if (l === level) {
        consoleEl.style.display = 'block';
        if (!userScrolledUpMap[l]) {
          consoleEl.scrollTop = consoleEl.scrollHeight;
        }
      } else {
        consoleEl.style.display = 'none';
      }
    }
  });
  
  // Update autoscroll checkbox
  const autoScrollCheckbox = document.getElementById('log-autoscroll');
  if (autoScrollCheckbox) {
    autoScrollCheckbox.checked = !userScrolledUpMap[level];
  }
}

// Smart scrolling lock logic
function setupSmartScroll() {
  const levels = ['debug', 'info', 'warning', 'error'];
  levels.forEach(level => {
    const consoleEl = document.getElementById(`log-console-${level}`);
    if (!consoleEl) return;
    
    consoleEl.addEventListener('scroll', () => {
      const threshold = 30; // px tolerance
      const isAtBottom = (consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight) < threshold;
      
      if (isAtBottom) {
        userScrolledUpMap[level] = false;
        if (level === activeLogLevel) {
          const autoScrollCheckbox = document.getElementById('log-autoscroll');
          if (autoScrollCheckbox) autoScrollCheckbox.checked = true;
        }
      } else {
        userScrolledUpMap[level] = true;
        if (level === activeLogLevel) {
          const autoScrollCheckbox = document.getElementById('log-autoscroll');
          if (autoScrollCheckbox) autoScrollCheckbox.checked = false;
        }
      }
    });
  });
  
  const autoScrollCheckbox = document.getElementById('log-autoscroll');
  if (autoScrollCheckbox) {
    autoScrollCheckbox.onchange = function() {
      const consoleEl = document.getElementById(`log-console-${activeLogLevel}`);
      if (!consoleEl) return;
      
      if (this.checked) {
        userScrolledUpMap[activeLogLevel] = false;
        consoleEl.scrollTop = consoleEl.scrollHeight;
      } else {
        userScrolledUpMap[activeLogLevel] = true;
      }
    };
  }
}

// Bind logs controls
const logSearchBox = document.getElementById('log-search-box');
if (logSearchBox) {
  logSearchBox.oninput = reRenderLogs;
}

const btnClearLogs = document.getElementById('btn-clear-logs');
if (btnClearLogs) {
  btnClearLogs.onclick = function() {
    logsCache = [];
    const levels = ['debug', 'info', 'warning', 'error'];
    levels.forEach(level => {
      const consoleEl = document.getElementById(`log-console-${level}`);
      if (consoleEl) consoleEl.innerHTML = '';
    });
    showToast('Консоли очищены!');
  };
}


// --- 4. Trace Route Diagnostic Tool ---
const btnRunTrace = document.getElementById('btn-run-trace');
if (btnRunTrace) {
  btnRunTrace.onclick = runTraceTest;
}

const traceDomainInput = document.getElementById('trace-domain-input');
if (traceDomainInput) {
  traceDomainInput.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') {
      runTraceTest();
    }
  });
}

async function runTraceTest() {
  const inputEl = document.getElementById('trace-domain-input');
  if (!inputEl) return;
  
  const domain = inputEl.value.trim();
  if (!domain) {
    showToast('Введите доменное имя для проверки!', 'error');
    return;
  }
  
  const btn = document.getElementById('btn-run-trace');
  const loading = document.getElementById('trace-loading');
  const resultContainer = document.getElementById('trace-result-container');
  const stepsList = document.getElementById('trace-steps-list');
  
  btn.disabled = true;
  loading.style.display = 'block';
  resultContainer.style.display = 'none';
  stepsList.innerHTML = '';
  
  try {
    const res = await fetch('/api/xkeen/trace?domain=' + encodeURIComponent(domain));
    if (!res.ok) throw new Error('Tracing API request failed');
    const data = await res.json();
    
    if (data.success) {
      // Render general details
      document.getElementById('trace-ips').textContent = data.ips.join(', ') || 'Не определены';
      document.getElementById('trace-country').textContent = data.country ? `${data.country}` : 'Неизвестно';
      
      const finalRouteEl = document.getElementById('trace-final-route');
      finalRouteEl.textContent = data.matchedPolicy || 'DIRECT';
      
      // Color code final route output badge
      if (data.matchedPolicy === 'DIRECT') {
        finalRouteEl.style.color = 'var(--success)';
      } else if (data.matchedPolicy === 'REJECT') {
        finalRouteEl.style.color = 'var(--danger)';
      } else {
        finalRouteEl.style.color = 'var(--md-sys-color-primary)';
      }
      
      // Render matching evaluation trace list
      data.steps.forEach(step => {
        const div = document.createElement('div');
        div.className = 'trace-step ' + (step.matched ? 'matched' : 'skipped');
        
        const title = document.createElement('div');
        title.className = 'trace-step-title';
        
        const icon = document.createElement('span');
        icon.className = step.matched ? 'trace-icon-match' : 'trace-icon-skip';
        icon.textContent = step.matched ? '✅ ' : '❌ ';
        
        title.appendChild(icon);
        title.appendChild(document.createTextNode(step.rule));
        
        const desc = document.createElement('div');
        desc.className = 'trace-step-desc';
        desc.textContent = step.reason;
        
        div.appendChild(title);
        div.appendChild(desc);
        stepsList.appendChild(div);
      });
      
      resultContainer.style.display = 'block';
    } else {
      showToast(data.error || 'Ошибка трассировки', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    loading.style.display = 'none';
  }
}

// --- Window load initializer ---
window.addEventListener('load', () => {
  // Start persistent streams immediately when panel loads
  startLogsStream();
  startTrafficStream();
  
  // Setup smart scrolling locking event bindings
  setupSmartScroll();
  
  // Bind log level segmented buttons
  const buttons = document.querySelectorAll('.log-level-btn');
  buttons.forEach(btn => {
    btn.onclick = () => {
      switchLogLevel(btn.dataset.level);
    };
  });
});
