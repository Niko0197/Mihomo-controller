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
  if (isNaN(bytes) || bytes === null || bytes === undefined || bytes <= 0) return '0.00 MB';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i < 0) return bytes + ' Bytes';
  const sizeIdx = Math.min(i, sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, sizeIdx)).toFixed(2)) + ' ' + sizes[sizeIdx];
}

// Helper to format speeds
function formatSpeed(bytesPerSec) {
  if (isNaN(bytesPerSec) || bytesPerSec === null || bytesPerSec === undefined || bytesPerSec <= 0) return '0 KB/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  if (i < 0) return bytesPerSec.toFixed(1) + ' B/s';
  const sizeIdx = Math.min(i, sizes.length - 1);
  return parseFloat((bytesPerSec / Math.pow(k, sizeIdx)).toFixed(1)) + ' ' + sizes[sizeIdx];
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
  
  // Update clients polling mode based on current tab
  if (tabId === 'clients') {
    startClientsPolling(false); // Active rendering
  } else {
    startClientsPolling(true); // Silent background polling
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
    if (window.isXkeenRunning) {
      reRenderLogs();
    }
  } else if (tabId === 'proxies-dashboard') {
    if (window.isXkeenRunning) {
      loadProxiesDashboard();
    }
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
  
  // We also poll connections in the background to calculate volume stats
  startConnectionsPolling(true); // silent background poll
  
  trafficAbortController = new AbortController();
  
  async function runStream() {
    while (trafficAbortController && !trafficAbortController.signal.aborted) {
      if (statusEl) statusEl.textContent = 'Подключение...';
      try {
        await readHttpStream('/api/xkeen/traffic', (data) => {
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
      } catch (err) {
        console.error('Traffic stream failed, retrying in 3s...', err);
      }
      
      if (trafficAbortController && !trafficAbortController.signal.aborted) {
        if (statusEl) statusEl.textContent = 'Переподключение...';
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  runStream();
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
  if (!window.isXkeenRunning) return;
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
  
  async function runStream() {
    while (logsAbortController && !logsAbortController.signal.aborted) {
      try {
        // Always query with 'debug' level to capture all events in background, then filter client-side
        await readHttpStream('/api/xkeen/logs?level=debug', (logObj) => {
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
      } catch (err) {
        console.error('Logs stream failed, retrying in 3s...', err);
      }
      
      if (logsAbortController && !logsAbortController.signal.aborted) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  runStream();
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
  const buttons = document.querySelectorAll('#log-level-tabs .log-level-btn');
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

// Helper to extract logs text according to the current tab and filter
function getFilteredLogsText() {
  const levels = ['debug', 'info', 'warning', 'error'];
  const currentIdx = levels.indexOf(activeLogLevel);
  if (currentIdx === -1) return '';
  
  const queryInput = document.getElementById('log-search-box');
  const query = queryInput ? queryInput.value.toLowerCase() : '';
  
  const filteredLines = [];
  logsCache.forEach(logObj => {
    const logType = logObj.type.toLowerCase();
    const typeIdx = levels.indexOf(logType);
    if (typeIdx === -1 || typeIdx < currentIdx) return;
    
    if (query && !logObj.payload.toLowerCase().includes(query)) return;
    
    filteredLines.push(`[${logObj.timeStr}] [${logObj.type.toUpperCase()}] ${logObj.payload}`);
  });
  
  // Get last 1000 lines of filtered logs
  return filteredLines.slice(-1000).join('\n');
}

function downloadActiveLogs() {
  const text = getFilteredLogsText();
  if (!text) {
    showToast('Нет логов для скачивания', 'error');
    return;
  }
  
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.download = `mihomo-logs-${activeLogLevel}-${timestamp}.txt`;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast('Файл логов скачивается', 'success');
}

// Bind logs controls
const logSearchBox = document.getElementById('log-search-box');
if (logSearchBox) {
  logSearchBox.oninput = reRenderLogs;
}

const btnDownloadLogs = document.getElementById('btn-download-logs');
if (btnDownloadLogs) {
  btnDownloadLogs.onclick = downloadActiveLogs;
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
  const buttons = document.querySelectorAll('#log-level-tabs .log-level-btn');
  buttons.forEach(btn => {
    btn.onclick = () => {
      switchLogLevel(btn.dataset.level);
    };
  });

  // Инициализация новых компонентов
  setupSystemMonitorToggle();
  startSystemStatsPolling();
  startClientsPolling(true); // Фоновое обновление списка клиентов
});

// --- 5. Proxy Dashboard (Groups & Providers) ---

let proxyDashboardData = null;

function switchProxySubtab(subtab) {
  const groupsContent = document.getElementById('proxy-subtab-content-groups');
  const providersContent = document.getElementById('proxy-subtab-content-providers');
  const btnGroups = document.getElementById('btn-subtab-groups');
  const btnProviders = document.getElementById('btn-subtab-providers');

  if (subtab === 'groups') {
    groupsContent.style.display = 'block';
    providersContent.style.display = 'none';
    btnGroups.classList.add('active');
    btnProviders.classList.remove('active');
  } else {
    groupsContent.style.display = 'none';
    providersContent.style.display = 'block';
    btnGroups.classList.remove('active');
    btnProviders.classList.add('active');
  }
}
window.switchProxySubtab = switchProxySubtab;

function getLastDelay(proxy) {
  if (!proxy || !proxy.history || proxy.history.length === 0) return 0;
  return proxy.history[proxy.history.length - 1].delay || 0;
}

function resolveSelectedProxyDelay(proxyName, proxies) {
  let current = proxies[proxyName];
  if (!current) return 0;
  
  let limit = 5;
  while (current && current.now && limit > 0) {
    const next = proxies[current.now];
    if (!next) break;
    current = next;
    limit--;
  }
  return getLastDelay(current);
}

function getLatencyBgColor(delay) {
  if (!delay || delay === 0) return 'rgba(255, 255, 255, 0.05)';
  if (delay < 200) return 'rgba(61, 220, 132, 0.15)';
  if (delay < 500) return 'rgba(255, 183, 77, 0.15)';
  return 'rgba(255, 138, 128, 0.15)';
}

async function pingProxyNode(nodeName) {
  try {
    showToast(`⚡ Измеряем пинг для ${nodeName}...`);
    const res = await fetch('/api/proxies/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nodeName })
    });
    if (!res.ok) throw new Error('Ошибка HTTP ' + res.status);
    const data = await res.json();
    if (data.success && data.delay > 0) {
      showToast(`✅ Пинг ${nodeName}: ${data.delay} ms`, 'success');
    } else {
      showToast(`❌ Пинг ${nodeName}: таймаут или ошибка`, 'error');
    }
    loadProxiesDashboard();
  } catch (err) {
    showToast('Ошибка пинга: ' + err.message, 'error');
  }
}

function getLatencyDotClass(delay) {
  if (!delay || delay === 0) return 'lat-none';
  if (delay < 200) return 'lat-fast';
  if (delay < 500) return 'lat-medium';
  return 'lat-slow';
}

function getLatencyColor(delay) {
  if (!delay || delay === 0) return 'var(--text-muted)';
  if (delay < 200) return '#3ddc84';
  if (delay < 500) return '#ffb74d';
  return '#ff8a80';
}

async function loadProxiesDashboard() {
  try {
    const [proxiesRes, providersRes] = await Promise.all([
      fetch('/api/xkeen/proxies'),
      fetch('/api/xkeen/providers')
    ]);

    if (!proxiesRes.ok) {
      const errBody = await proxiesRes.text();
      console.error('Proxies API error:', proxiesRes.status, errBody);
      throw new Error('Прокси API: HTTP ' + proxiesRes.status + ' — ' + (errBody || 'нет ответа').substring(0, 120));
    }
    if (!providersRes.ok) {
      const errBody = await providersRes.text();
      console.error('Providers API error:', providersRes.status, errBody);
      throw new Error('Провайдеры API: HTTP ' + providersRes.status + ' — ' + (errBody || 'нет ответа').substring(0, 120));
    }

    const proxiesData = await proxiesRes.json();
    const providersData = await providersRes.json();
    proxyDashboardData = { proxies: proxiesData, providers: providersData };

    renderProxyGroups(proxiesData);
    renderProxyProviders(providersData, proxiesData);
  } catch (err) {
    console.error('Proxy dashboard error:', err);
    showToast('Ошибка прокси-панели: ' + err.message, 'error');

    // Show error in containers too
    const gc = document.getElementById('proxy-groups-container');
    if (gc) gc.innerHTML = '<div style="text-align:center;color:var(--danger);padding:30px 0;font-size:0.9rem;">' + err.message + '<br><br><button class="btn btn-primary" style="font-size:0.85rem;padding:6px 16px;" onclick="loadProxiesDashboard()">🔄 Повторить</button></div>';
  }
}
window.loadProxiesDashboard = loadProxiesDashboard;

function renderProxyGroups(proxiesData) {
  const container = document.getElementById('proxy-groups-container');
  if (!container) return;

  const proxies = proxiesData.proxies || {};
  const excludeNames = ['GLOBAL', 'DIRECT', 'REJECT'];
  const groups = [];

  for (const [name, proxy] of Object.entries(proxies)) {
    if (excludeNames.includes(name)) continue;
    if (proxy.all && Array.isArray(proxy.all)) {
      groups.push({ name, ...proxy });
    }
  }

  if (groups.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px 0;">Прокси-группы не найдены в ядре</div>';
    return;
  }

  container.innerHTML = '';

  groups.forEach(group => {
    const card = document.createElement('div');
    card.className = 'pgc-card';
    card.dataset.groupName = group.name;

    const isSelector = group.type.toLowerCase() === 'selector';
    const totalNodes = group.all.length;
    let aliveCount = 0;
    group.all.forEach(n => {
      const np = proxies[n];
      if (np && getLastDelay(np) > 0) aliveCount++;
    });

    const typeIcons = { selector: '🔀', urltest: '⚡', 'url-test': '⚡', fallback: '🛡️', loadbalance: '⚖️', 'load-balance': '⚖️', relay: '🔗' };
    const typeLabels = { selector: 'Selector', urltest: 'URLTest', 'url-test': 'URLTest', fallback: 'Fallback', loadbalance: 'LoadBalance', 'load-balance': 'LoadBalance', relay: 'Relay' };
    const icon = typeIcons[group.type.toLowerCase()] || '📡';
    const typeLabel = typeLabels[group.type.toLowerCase()] || group.type;

    const localVal = localStorage.getItem('pgc-collapsed-' + group.name);
    const isCollapsed = localVal !== null ? localVal === 'true' : true;
    if (isCollapsed) {
      card.classList.add('pgc-collapsed');
    }

    const nowName = group.now || '—';
    const nowProxy = proxies[nowName];
    const nowDelay = getLastDelay(nowProxy);
    const resolvedActiveDelay = resolveSelectedProxyDelay(group.name, proxies);
    const delayText = resolvedActiveDelay > 0 ? `${resolvedActiveDelay} ms` : '—';

    // --- Header ---
    const header = document.createElement('div');
    header.className = 'pgc-header';
    header.innerHTML = `
      <div class="pgc-header-left">
        <span class="pgc-icon">${icon}</span>
        <span class="pgc-name">${group.name}</span>
        <span class="pgc-meta">·&nbsp;${typeLabel}&nbsp;·&nbsp;${aliveCount}/${totalNodes}</span>
      </div>
      <div class="pgc-header-right">
        <span class="pgc-count-badge" style="color: ${getLatencyColor(resolvedActiveDelay)}; background: ${getLatencyBgColor(resolvedActiveDelay)}">${delayText}</span>
        <span class="pgc-toggle-arrow">${isCollapsed ? '▸' : '▾'}</span>
      </div>
    `;

    // Toggle collapse on left click
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      if (e.target.closest('.pgc-node-btn') || e.target.closest('.pgc-dot') || e.target.closest('button') || e.target.closest('a') || e.target.closest('input')) {
        return;
      }
      const nowCollapsed = card.classList.toggle('pgc-collapsed');
      localStorage.setItem('pgc-collapsed-' + group.name, nowCollapsed ? 'true' : 'false');
      const arrow = header.querySelector('.pgc-toggle-arrow');
      if (arrow) {
        arrow.textContent = nowCollapsed ? '▸' : '▾';
      }
    });

    // Ping selected proxy on right click
    card.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.pgc-node-btn') || e.target.closest('.pgc-dot') || e.target.closest('button') || e.target.closest('a') || e.target.closest('input')) {
        return;
      }
      e.preventDefault();
      const targetName = group.now || '—';
      if (targetName && targetName !== '—') {
        pingProxyNode(targetName);
      }
    });

    const selected = document.createElement('div');
    selected.className = 'pgc-selected';
    selected.innerHTML = `
      <span class="pgc-sel-icon">⊙</span>
      <span class="pgc-sel-check">✓</span>
      <span class="pgc-sel-name">${nowName}</span>
      ${nowDelay > 0 ? '<span class="pgc-sel-delay" style="color:' + getLatencyColor(nowDelay) + '">' + nowDelay + 'ms</span>' : ''}
    `;

    // --- Latency dots row (always visible in card body) ---
    const dotsRow = document.createElement('div');
    dotsRow.className = 'pgc-dots';
    group.all.forEach(nodeName => {
      const np = proxies[nodeName];
      const d = getLastDelay(np);
      const dot = document.createElement('span');
      dot.className = 'pgc-dot ' + getLatencyDotClass(d);
      dot.title = nodeName + ': ' + (d > 0 ? d + 'ms' : 'N/A');
      if (nodeName === group.now) dot.classList.add('pgc-dot-active');
      if (isSelector) {
        dot.style.cursor = 'pointer';
        dot.addEventListener('click', () => selectProxyInGroup(group.name, nodeName));
      }
      dotsRow.appendChild(dot);
    });

    // --- Node buttons panel (for Selector groups) ---
    let nodesPanel = null;
    if (isSelector && totalNodes <= 30) {
      nodesPanel = document.createElement('div');
      nodesPanel.className = 'pgc-nodes-panel';
      nodesPanel.style.display = 'flex'; // Always visible when card is expanded

      group.all.forEach(nodeName => {
        const np = proxies[nodeName];
        const d = getLastDelay(np);
        const isActive = nodeName === group.now;
        const isChildGroup = np && np.all && Array.isArray(np.all);
        const childType = np ? np.type : '';
        const resolvedChildDelay = isChildGroup ? resolveSelectedProxyDelay(nodeName, proxies) : 0;

        const btn = document.createElement('button');
        btn.className = 'pgc-node-btn' + (isActive ? ' active' : '');

        btn.innerHTML = `
          <span class="pgc-nb-dot ${getLatencyDotClass(d)}"></span>
          <span class="pgc-nb-name">${nodeName}</span>
          ${isChildGroup ? '<span class="pgc-nb-type">' + childType + '</span>' : ''}
          ${(!isChildGroup && d > 0) ? '<span class="pgc-nb-delay" style="color:' + getLatencyColor(d) + '">' + d + 'ms</span>' : ''}
          ${isChildGroup ? `<span class="pgc-nb-count" style="color:${getLatencyColor(resolvedChildDelay)};background:${getLatencyBgColor(resolvedChildDelay)}">${resolvedChildDelay > 0 ? resolvedChildDelay + ' ms' : '—'}</span>` : ''}
        `;

        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          selectProxyInGroup(group.name, nodeName);
        });
        nodesPanel.appendChild(btn);
      });
    }

    const body = document.createElement('div');
    body.className = 'pgc-body';
    body.appendChild(selected);
    body.appendChild(dotsRow);
    if (nodesPanel) body.appendChild(nodesPanel);

    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);
  });
}

function renderProxyProviders(providersData, proxiesData) {
  const container = document.getElementById('proxy-providers-container');
  if (!container) return;

  const providers = providersData.providers || {};
  const providerList = Object.values(providers).filter(p => p.vehicleType !== 'Compatible' && p.name !== 'default');

  if (providerList.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px 0;">Подписочные провайдеры не найдены</div>';
    return;
  }

  container.innerHTML = '';

  providerList.forEach(provider => {
    const card = document.createElement('div');
    card.className = 'pgc-card pgc-provider';

    const localVal = localStorage.getItem('pgc-collapsed-' + provider.name);
    const isCollapsed = localVal !== null ? localVal === 'true' : true;
    if (isCollapsed) {
      card.classList.add('pgc-collapsed');
    }

    const nodesList = provider.proxies || [];
    const total = nodesList.length;
    let alive = 0;
    nodesList.forEach(p => { if (getLastDelay(p) > 0) alive++; });

    const updatedAt = provider.updatedAt ? new Date(provider.updatedAt).toLocaleString('ru-RU') : '—';

    // Subscription info
    const sub = provider.subscriptionInfo;
    let subHtml = '';
    if (sub) {
      const usedBytes = (sub.Upload || 0) + (sub.Download || 0);
      const totalBytes = sub.Total || 0;
      const usedGB = usedBytes / (1024 ** 3);
      const totalGB = totalBytes / (1024 ** 3);
      const pct = totalGB > 0 ? Math.min(100, Math.round((usedGB / totalGB) * 100)) : 0;
      const expDate = sub.Expire ? new Date(sub.Expire * 1000).toLocaleDateString('ru-RU') : null;
      const barColor = pct > 80 ? '#ff8a80' : pct > 50 ? '#ffb74d' : '#3ddc84';

      subHtml = `<div class="pgc-sub-info">
        ${totalGB > 0 ? `<div class="pgc-sub-bar-wrap">
          <div class="pgc-sub-bar"><div class="pgc-sub-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
          <span class="pgc-sub-text">${usedGB.toFixed(1)} / ${totalGB.toFixed(0)} GB (${pct}%)</span>
        </div>` : ''}
        ${expDate ? `<span class="pgc-sub-expire">⏰ до ${expDate}</span>` : ''}
      </div>`;
    }

    // Header
    const header = document.createElement('div');
    header.className = 'pgc-header';
    header.innerHTML = `
      <div class="pgc-header-left">
        <span class="pgc-icon">📦</span>
        <span class="pgc-name">${provider.name}</span>
        <span class="pgc-meta">·&nbsp;${provider.vehicleType || 'HTTP'}</span>
      </div>
      <div class="pgc-header-right">
        <span class="pgc-count-badge">${total}</span>
        <button class="pgc-hc-btn" title="Обновить подписку" onclick="event.stopPropagation();updateProviderSub('${provider.name.replace(/'/g, "\\'")}')">🔄</button>
        <button class="pgc-hc-btn pgc-hc-bolt" title="Healthcheck" onclick="event.stopPropagation();healthcheckProvider('${provider.name.replace(/'/g, "\\'")}')">⚡</button>
        <span class="pgc-toggle-arrow">${isCollapsed ? '▸' : '▾'}</span>
      </div>
    `;

    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('a') || e.target.closest('input')) {
        return;
      }
      const nowCollapsed = card.classList.toggle('pgc-collapsed');
      localStorage.setItem('pgc-collapsed-' + provider.name, nowCollapsed ? 'true' : 'false');
      const arrow = header.querySelector('.pgc-toggle-arrow');
      if (arrow) {
        arrow.textContent = nowCollapsed ? '▸' : '▾';
      }
    });

    card.addEventListener('contextmenu', (e) => {
      if (e.target.closest('button') || e.target.closest('a') || e.target.closest('input')) {
        return;
      }
      e.preventDefault();
      healthcheckProvider(provider.name);
    });

    // Info row
    const info = document.createElement('div');
    info.className = 'pgc-prov-info';
    info.innerHTML = `
      <span class="pgc-prov-time">🕐 ${updatedAt}</span>
      <span class="pgc-prov-alive">${alive} / ${total} живых</span>
    `;

    // Sub info
    const subDiv = document.createElement('div');
    subDiv.innerHTML = subHtml;

    // Dots
    const dotsRow = document.createElement('div');
    dotsRow.className = 'pgc-dots';
    nodesList.forEach(p => {
      const d = getLastDelay(p);
      const dot = document.createElement('span');
      dot.className = 'pgc-dot ' + getLatencyDotClass(d);
      dot.title = p.name + ': ' + (d > 0 ? d + 'ms' : 'N/A') + ' (' + p.type + ')';
      dotsRow.appendChild(dot);
    });

    // Expandable nodes panel
    const nodesPanel = document.createElement('div');
    nodesPanel.className = 'pgc-nodes-panel pgc-prov-nodes';
    nodesPanel.style.display = 'none';

    nodesList.forEach(p => {
      const d = getLastDelay(p);
      const nodeDiv = document.createElement('div');
      nodeDiv.className = 'pgc-prov-node';
      nodeDiv.innerHTML = `
        <span class="pgc-nb-dot ${getLatencyDotClass(d)}"></span>
        <span class="pgc-nb-name">${p.name}</span>
        <span class="pgc-nb-type">${p.type}</span>
        ${d > 0 ? '<span class="pgc-nb-delay" style="color:' + getLatencyColor(d) + '">' + d + 'ms</span>' : '<span class="pgc-nb-delay" style="color:var(--text-muted)">—</span>'}
      `;
      nodesPanel.appendChild(nodeDiv);
    });

    // Button to toggle nodes panel inside card body
    const toggleNodesBtn = document.createElement('button');
    toggleNodesBtn.className = 'pgc-prov-toggle-nodes-btn';
    toggleNodesBtn.textContent = 'Показать список узлов';
    toggleNodesBtn.style.margin = '10px 0 2px';
    toggleNodesBtn.style.background = 'none';
    toggleNodesBtn.style.border = 'none';
    toggleNodesBtn.style.color = 'var(--md-sys-color-primary)';
    toggleNodesBtn.style.fontSize = '0.8rem';
    toggleNodesBtn.style.cursor = 'pointer';
    toggleNodesBtn.style.padding = '0';
    toggleNodesBtn.style.textAlign = 'left';
    toggleNodesBtn.style.fontFamily = 'Inter, sans-serif';
    toggleNodesBtn.style.fontWeight = '500';

    toggleNodesBtn.addEventListener('click', () => {
      const shown = nodesPanel.style.display !== 'none';
      nodesPanel.style.display = shown ? 'none' : 'flex';
      toggleNodesBtn.textContent = shown ? 'Показать список узлов' : 'Скрыть список узлов';
    });

    const body = document.createElement('div');
    body.className = 'pgc-body';
    body.appendChild(info);
    body.appendChild(subDiv);
    body.appendChild(dotsRow);
    body.appendChild(toggleNodesBtn);
    body.appendChild(nodesPanel);

    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);
  });
}

async function selectProxyInGroup(groupName, nodeName) {
  try {
    const res = await fetch('/api/xkeen/proxies/' + encodeURIComponent(groupName), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nodeName })
    });
    if (res.ok) {
      showToast('✅ ' + groupName + ' → ' + nodeName);
      await loadProxiesDashboard();
    } else {
      showToast('Ошибка переключения прокси', 'error');
    }
  } catch (err) {
    showToast('Ошибка сети: ' + err.message, 'error');
  }
}
window.selectProxyInGroup = selectProxyInGroup;

async function healthcheckProvider(providerName) {
  try {
    showToast('⚡ Healthcheck: ' + providerName + '...');
    const res = await fetch('/api/xkeen/providers/' + encodeURIComponent(providerName) + '/healthcheck');
    if (res.ok) {
      showToast('✅ Healthcheck ' + providerName + ' завершён');
      setTimeout(() => loadProxiesDashboard(), 1200);
    } else {
      showToast('Ошибка healthcheck: ' + providerName, 'error');
    }
  } catch (err) {
    showToast('Ошибка сети: ' + err.message, 'error');
  }
}
window.healthcheckProvider = healthcheckProvider;

async function updateProviderSub(providerName) {
  try {
    showToast('🔄 Обновление подписки: ' + providerName + '...');
    const res = await fetch('/api/providers/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: providerName })
    });
    const data = await res.json();
    if (data.success) {
      showToast('✅ Подписка ' + providerName + ' обновлена');
      setTimeout(() => loadProxiesDashboard(), 1500);
    } else {
      showToast('Ошибка обновления: ' + (data.message || ''), 'error');
    }
  } catch (err) {
    showToast('Ошибка сети: ' + err.message, 'error');
  }
}
window.updateProviderSub = updateProviderSub;

async function healthcheckAllGroups() {
  const btn = document.getElementById('btn-ping-all-groups');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Тестируем...'; }
  try {
    const res = await fetch('/api/xkeen/providers');
    if (!res.ok) throw new Error('Ошибка получения провайдеров');
    const data = await res.json();
    const providers = data.providers || {};

    const tasks = [];
    for (const [name, prov] of Object.entries(providers)) {
      if (prov.vehicleType !== 'Compatible' && name !== 'default') {
        tasks.push(
          fetch('/api/xkeen/providers/' + encodeURIComponent(name) + '/healthcheck')
            .catch(e => console.error('HC fail:', name, e))
        );
      }
    }
    await Promise.all(tasks);
    showToast('✅ Healthcheck всех провайдеров завершён!');
    setTimeout(() => loadProxiesDashboard(), 1500);
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Тест задержки'; }
  }
}
window.healthcheckAllGroups = healthcheckAllGroups;

// --- 6. Router System Resources Monitor (Sidebar) ---
let systemStatsInterval = null;
let systemStatsHistory = {
  cpu: Array(60).fill(0),
  ram: Array(60).fill(0),
  temp: Array(60).fill(0),
  labels: Array(60).fill('')
};
let sysResourceChart = null;

function initSysResourceChart() {
  const canvas = document.getElementById('sys-resource-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  sysResourceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: systemStatsHistory.labels,
      datasets: [
        {
          label: 'ЦП (%)',
          data: systemStatsHistory.cpu,
          borderColor: '#a8c7fa',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false
        },
        {
          label: 'ОЗУ (%)',
          data: systemStatsHistory.ram,
          borderColor: '#3ddc84',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false
        },
        {
          label: 'Темп (°C)',
          data: systemStatsHistory.temp,
          borderColor: '#ffb74d',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: true }
      },
      scales: {
        x: { display: false },
        y: {
          min: 0,
          max: 100,
          ticks: {
            color: '#9094a6',
            font: { size: 8 }
          },
          grid: { color: 'rgba(255, 255, 255, 0.03)' }
        }
      }
    }
  });
}

function startSystemStatsPolling() {
  const poll = async () => {
    try {
      const res = await fetch('/api/system/stats');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success) return;
      
      const stats = data.stats;
      
      // Update DOM elements
      const cpuVal = document.getElementById('sys-cpu-val');
      const cpuBar = document.getElementById('sys-cpu-bar');
      if (cpuVal) cpuVal.textContent = stats.cpu + '%';
      if (cpuBar) {
        cpuBar.style.width = stats.cpu + '%';
        if (stats.cpu > 85) {
          cpuBar.style.background = '#ff8a80';
        } else {
          cpuBar.style.background = 'var(--md-sys-color-primary)';
        }
      }
      
      const ramVal = document.getElementById('sys-ram-val');
      const ramBar = document.getElementById('sys-ram-bar');
      if (ramVal) ramVal.textContent = `${stats.ramUsedPercent}% (${stats.ramUsedMb} / ${stats.ramTotalMb} МБ)`;
      if (ramBar) ramBar.style.width = stats.ramUsedPercent + '%';
      
      const tempVal = document.getElementById('sys-temp-val');
      const tempBar = document.getElementById('sys-temp-bar');
      if (tempVal) tempVal.textContent = stats.temp + '°C';
      if (tempBar) {
        const tempPercent = Math.min(100, Math.round((stats.temp / 100) * 100));
        tempBar.style.width = tempPercent + '%';
        if (stats.temp > 75) {
          tempBar.style.background = '#ff8a80';
        } else {
          tempBar.style.background = '#ffb74d';
        }
      }

      // Update history for chart
      systemStatsHistory.cpu.shift();
      systemStatsHistory.cpu.push(stats.cpu);
      
      systemStatsHistory.ram.shift();
      systemStatsHistory.ram.push(stats.ramUsedPercent);
      
      systemStatsHistory.temp.shift();
      systemStatsHistory.temp.push(stats.temp);
      
      if (sysResourceChart) {
        sysResourceChart.update('none');
      }
    } catch (err) {
      console.error('System stats polling error:', err.message);
    }
  };
  
  poll();
  systemStatsInterval = setInterval(poll, 1000);
}

function setupSystemMonitorToggle() {
  const toggleBtn = document.getElementById('system-monitor-toggle');
  const body = document.getElementById('system-monitor-body');
  const arrow = document.getElementById('system-monitor-arrow');
  
  if (!toggleBtn || !body || !arrow) return;
  
  const isExpanded = localStorage.getItem('system-monitor-expanded') === 'true';
  if (isExpanded) {
    body.style.display = 'block';
    arrow.textContent = '▾';
    setTimeout(() => {
      if (!sysResourceChart) initSysResourceChart();
    }, 50);
  } else {
    body.style.display = 'none';
    arrow.textContent = '▸';
  }
  
  toggleBtn.addEventListener('click', () => {
    const isCurrentlyHidden = body.style.display === 'none';
    if (isCurrentlyHidden) {
      body.style.display = 'block';
      arrow.textContent = '▾';
      localStorage.setItem('system-monitor-expanded', 'true');
      if (!sysResourceChart) {
        initSysResourceChart();
      } else {
        sysResourceChart.update('none');
      }
    } else {
      body.style.display = 'none';
      arrow.textContent = '▸';
      localStorage.setItem('system-monitor-expanded', 'false');
    }
  });
}


// --- 7. Clients (Devices) Dashboard ---
let allClients = [];
let allProxyGroups = [];
let clientsInterval = null;
let clientsSilentMode = true;

function startClientsPolling(silent = false) {
  clientsSilentMode = silent;
  stopClientsPolling();
  
  if (!silent) {
    const tbody = document.getElementById('clients-list');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">Инициализация списка устройств...</td></tr>';
  }
  
  loadClients();
  clientsInterval = setInterval(loadClients, silent ? 10000 : 2000);
}

function stopClientsPolling() {
  if (clientsInterval) {
    clearInterval(clientsInterval);
    clientsInterval = null;
  }
}

async function loadClients() {
  try {
    const res = await fetch('/api/clients');
    if (!res.ok) throw new Error('Failed to fetch clients');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Server error');
    
    allClients = data.clients || [];
    allProxyGroups = data.groups || [];
    renderClientsTable();
  } catch (err) {
    console.error('Error loading clients:', err.message);
    if (!clientsSilentMode) {
      const tbody = document.getElementById('clients-list');
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 30px;">Ошибка: ${err.message}</td></tr>`;
      }
    }
  }
}

function renderClientsTable() {
  // Update stats counter
  const total = allClients.length;
  const activeCount = allClients.filter(c => c.active).length;
  const directCount = allClients.filter(c => !c.vpnEnabled).length;
  
  const counterEl = document.getElementById('clients-stats-counter');
  if (counterEl) {
    counterEl.textContent = `Всего: ${total} · Активно: ${activeCount} · Обход VPN: ${directCount}`;
  }

  // If the user is currently interacting with the group select dropdown, skip re-rendering to prevent it from closing
  if (document.activeElement && document.activeElement.classList.contains('group-select')) {
    return;
  }

  // If in background silent mode, don't build DOM to save CPU
  if (clientsSilentMode) return;
  
  const tbody = document.getElementById('clients-list');
  if (!tbody) return;
  
  const searchInput = document.getElementById('clients-search-box');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  
  const filtered = allClients.filter(c => {
    const name = (c.name || '').toLowerCase();
    const ip = (c.ip || '').toLowerCase();
    const mac = (c.mac || '').toLowerCase();
    return name.includes(query) || ip.includes(query) || mac.includes(query);
  });
  
  tbody.innerHTML = '';
  
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 30px;">Устройства не найдены</td></tr>';
    return;
  }
  
  filtered.forEach(c => {
    const tr = document.createElement('tr');
    
    // Device info (Name, IP, MAC)
    const tdDevice = document.createElement('td');
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'editable-name';
    nameSpan.title = 'Нажмите, чтобы изменить имя';
    nameSpan.innerHTML = `${c.name || '<i>Устройство без имени</i>'} <svg width="12" height="12" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
    nameSpan.onclick = () => promptRenameClient(c.ip, c.name);
    
    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'client-ip-mac';
    detailsDiv.textContent = `${c.ip} ${c.mac ? '· ' + c.mac : ''}`;
    
    tdDevice.appendChild(nameSpan);
    tdDevice.appendChild(detailsDiv);
    
    // State badge
    const tdState = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `status-badge ${c.active ? 'active' : 'inactive'}`;
    badge.textContent = c.active ? 'Активен' : 'STALE';
    tdState.appendChild(badge);
    
    // Current speed
    const tdSpeed = document.createElement('td');
    tdSpeed.className = 'client-speed-text';
    if (c.active && (c.downSpeed > 0 || c.upSpeed > 0)) {
      tdSpeed.innerHTML = `<span style="color:#a8c7fa;">${formatSpeed(c.downSpeed)} ↓</span><br><span style="color:#3ddc84;">${formatSpeed(c.upSpeed)} ↑</span>`;
    } else {
      tdSpeed.innerHTML = '<span style="color:var(--text-muted);">0 KB/s</span>';
    }
    
    // VPN Cumulative traffic
    const tdVpnTraffic = document.createElement('td');
    tdVpnTraffic.className = 'client-traffic-text';
    const vpnTotal = c.vpnDownload + c.vpnUpload;
    if (vpnTotal > 0) {
      tdVpnTraffic.innerHTML = `<span>${formatBytes(vpnTotal)}</span><br><span style="font-size:0.75rem;opacity:0.7;">↓ ${formatBytes(c.vpnDownload)} / ↑ ${formatBytes(c.vpnUpload)}</span>`;
    } else {
      tdVpnTraffic.textContent = '—';
    }
    
    // DIRECT Cumulative traffic
    const tdDirectTraffic = document.createElement('td');
    tdDirectTraffic.className = 'client-traffic-text';
    const directTotal = c.directDownload + c.directUpload;
    if (directTotal > 0) {
      tdDirectTraffic.innerHTML = `<span>${formatBytes(directTotal)}</span><br><span style="font-size:0.75rem;opacity:0.7;">↓ ${formatBytes(c.directDownload)} / ↑ ${formatBytes(c.directUpload)}</span>`;
    } else {
      tdDirectTraffic.textContent = '—';
    }
    
    // VPN Toggle & Group dropdown select
    const tdToggle = document.createElement('td');
    tdToggle.style.textAlign = 'center';
    
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';
    container.style.gap = '12px';
    
    const label = document.createElement('label');
    label.className = 'switch';
    
    const realInput = document.createElement('input');
    realInput.type = 'checkbox';
    realInput.checked = c.vpnEnabled;
    
    const slider = document.createElement('span');
    slider.className = 'slider';
    
    label.appendChild(realInput);
    label.appendChild(slider);
    container.appendChild(label);
    
    const select = document.createElement('select');
    select.className = 'group-select';
    select.style.background = 'var(--bg-card)';
    select.style.color = 'var(--text-primary)';
    select.style.border = '1px solid var(--border-color)';
    select.style.borderRadius = '6px';
    select.style.padding = '4px 8px';
    select.style.fontSize = '0.85rem';
    select.style.outline = 'none';
    select.style.cursor = 'pointer';
    select.disabled = !c.vpnEnabled;
    
    const currentGroup = c.group || '🚀Auto-Best';


    allProxyGroups.forEach(g => {
      if (g === 'DIRECT' || g === 'REJECT') return;
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      if (g === currentGroup) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
    
    realInput.onchange = async () => {
      select.disabled = !realInput.checked;
      await toggleClientVpn(c.ip, realInput);
    };
    
    select.onchange = async () => {
      await changeClientGroup(c.ip, select.value, select);
    };
    
    container.appendChild(select);
    tdToggle.appendChild(container);
    
    tr.appendChild(tdDevice);
    tr.appendChild(tdState);
    tr.appendChild(tdSpeed);
    tr.appendChild(tdVpnTraffic);
    tr.appendChild(tdDirectTraffic);
    tr.appendChild(tdToggle);
    
    tbody.appendChild(tr);
  });
}

async function toggleClientVpn(ip, checkboxEl) {
  const vpnEnabled = checkboxEl.checked;
  checkboxEl.disabled = true;
  try {
    const res = await fetch('/api/clients/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, vpnEnabled })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Server error');
    
    showToast(`Правила для ${ip} успешно обновлены`);
    loadClients();
  } catch (err) {
    showToast(`Ошибка изменения правил: ${err.message}`, 'error');
    // revert checkbox back
    checkboxEl.checked = !vpnEnabled;
  } finally {
    checkboxEl.disabled = false;
  }
}

async function changeClientGroup(ip, group, selectEl) {
  selectEl.disabled = true;
  try {
    const res = await fetch('/api/clients/group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, group })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Server error');
    
    showToast(`Устройство ${ip} направлено в группу ${group}`);
    loadClients();
  } catch (err) {
    showToast(`Ошибка смены группы: ${err.message}`, 'error');
    loadClients();
  } finally {
    selectEl.disabled = false;
  }
}

async function promptRenameClient(ip, currentName) {
  const newName = prompt(`Введите имя для устройства (${ip}):`, currentName || '');
  if (newName === null) return; // cancel pressed
  
  try {
    const res = await fetch('/api/clients/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, name: newName })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Server error');
    
    showToast(`Имя устройства ${ip} обновлено`);
    loadClients();
  } catch (err) {
    showToast(`Ошибка сохранения имени: ${err.message}`, 'error');
  }
}

// Bind Clients Dashboard DOM listeners
const btnRefreshClients = document.getElementById('btn-refresh-clients');
if (btnRefreshClients) {
  btnRefreshClients.onclick = () => loadClients();
}

const clientsSearchBox = document.getElementById('clients-search-box');
if (clientsSearchBox) {
  clientsSearchBox.oninput = () => renderClientsTable();
}

