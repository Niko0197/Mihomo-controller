// public/app_monitoring.js

// Global state variables for streams and interval timers
let trafficAbortController = null;
let logsAbortController = null;
let connectionsInterval = null;
let connectionsSilentMode = false;

let currentTab = 'proxies-dashboard';
let activeLogLevel = 'info';
let userScrolledUpMap = {
  debug: false,
  info: false,
  warning: false,
  error: false
};

let trafficChartMode = 'split'; // 'split', 'combined', 'vpn', 'direct'
let trafficChart = null; // Combined or single chart
let trafficChartVPN = null; // Dedicated VPN chart
let trafficChartDirect = null; // Dedicated DIRECT chart

const chartDataPointsLimit = 60;
let trafficDownloadHistory = Array(chartDataPointsLimit).fill(0);
let trafficUploadHistory = Array(chartDataPointsLimit).fill(0);
let vpnDownloadHistory = Array(chartDataPointsLimit).fill(0);
let vpnUploadHistory = Array(chartDataPointsLimit).fill(0);
let directDownloadHistory = Array(chartDataPointsLimit).fill(0);
let directUploadHistory = Array(chartDataPointsLimit).fill(0);
let trafficLabels = Array(chartDataPointsLimit).fill('');

// Per-Device Traffic Tracking State
let trafficChartClients = null;
let selectedTrafficClientIp = 'ALL';
let clientTrafficHistories = new Map(); // ip => { ip, name, vpnDown: [], vpnUp: [], directDown: [], directUp: [], curVpnDown: 0, curVpnUp: 0, curDirectDown: 0, curDirectUp: 0, lastSeen: Date.now() }
let clientTrafficColorMap = new Map();
const clientColorPalette = [
  { vpn: '#38bdf8', direct: '#34d399' }, // Sky / Emerald
  { vpn: '#c084fc', direct: '#fbbf24' }, // Purple / Amber
  { vpn: '#f472b6', direct: '#2dd4bf' }, // Pink / Teal
  { vpn: '#818cf8', direct: '#a3e635' }, // Indigo / Lime
  { vpn: '#fb7185', direct: '#60a5fa' }, // Rose / Blue
  { vpn: '#fb923c', direct: '#4ade80' }, // Orange / Green
  { vpn: '#22d3ee', direct: '#e879f9' }, // Cyan / Fuchsia
  { vpn: '#a78bfa', direct: '#facc15' }  // Violet / Yellow
];

// Volumes & instantaneous rates tracking state
let activeConnectionsMap = new Map();
let lastConnBytesMap = new Map();
let vpnDownloadAccum = 0;
let vpnUploadAccum = 0;
let directDownloadAccum = 0;
let directUploadAccum = 0;

let instVpnDown = 0;
let instVpnUp = 0;
let instDirectDown = 0;
let instDirectUp = 0;
let lastVolumeCheckTime = Date.now();

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
  if (isNaN(bytesPerSec) || bytesPerSec === null || bytesPerSec === undefined || bytesPerSec <= 0) return '0.0 Кбит/с';
  const bitsPerSec = bytesPerSec * 8;
  const k = 1000;
  const sizes = ['бит/с', 'Кбит/с', 'Мбит/с', 'Гбит/с'];
  const i = Math.floor(Math.log(bitsPerSec) / Math.log(k));
  if (i < 0) return bitsPerSec.toFixed(1) + ' бит/с';
  const sizeIdx = Math.min(i, sizes.length - 1);
  return parseFloat((bitsPerSec / Math.pow(k, sizeIdx)).toFixed(1)) + ' ' + sizes[sizeIdx];
}

// --- Dynamic Tab Switching Hook ---
// Wrap the original switchTab function to start/stop streams accordingly
const originalSwitchTab = window.switchTab;
window.switchTab = function(tabId) {
  currentTab = tabId;
  // Call original logic to transition active classes
  originalSwitchTab(tabId);
  
  // Update connections polling mode based on current tab
  if (tabId === 'connections' || tabId === 'packet-monitor') {
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
  
  // If user switched to traffic tab, initialize and refresh the charts immediately
  if (tabId === 'traffic') {
    const speedDownEl = document.getElementById('speed-download');
    const speedUpEl = document.getElementById('speed-upload');
    const lastDown = trafficDownloadHistory[trafficDownloadHistory.length - 1] || 0;
    const lastUp = trafficUploadHistory[trafficUploadHistory.length - 1] || 0;
    
    if (speedDownEl) speedDownEl.textContent = formatSpeed(lastDown);
    if (speedUpEl) speedUpEl.textContent = formatSpeed(lastUp);
    
    initAllTrafficCharts();
    updateAllTrafficCharts();
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

let peakDownloadSpeed = 0;
let peakUploadSpeed = 0;

// Helper to create common chart options
function buildTrafficChartOptions(customTitle) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: {
      mode: 'index',
      intersect: false
    },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        align: 'end',
        labels: {
          color: '#94a3b8',
          usePointStyle: true,
          pointStyle: 'circle',
          padding: 12,
          font: { family: 'Inter', size: 11, weight: '600' }
        }
      },
      tooltip: {
        enabled: true,
        backgroundColor: 'rgba(15, 23, 42, 0.95)',
        titleColor: '#94a3b8',
        bodyColor: '#f8fafc',
        borderColor: 'rgba(255, 255, 255, 0.1)',
        borderWidth: 1,
        bodyFont: { family: 'Inter', size: 12, weight: '600' },
        padding: 10,
        boxWidth: 8,
        boxHeight: 8,
        usePointStyle: true,
        cornerRadius: 10,
        caretPadding: 8,
        callbacks: {
          title: function(items) {
            if (items.length > 0) {
              const idx = items[0].dataIndex;
              const secsAgo = (chartDataPointsLimit - 1 - idx);
              return secsAgo === 0 ? 'Сейчас' : `${secsAgo} сек назад`;
            }
            return '';
          },
          label: function(context) {
            let label = context.dataset.label || '';
            if (label) label += ': ';
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
        ticks: {
          color: '#64748b',
          font: { family: 'Inter', size: 10 },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 6,
          callback: function(val, index) {
            const secs = chartDataPointsLimit - 1 - index;
            if (secs === 0) return 'Сейчас';
            if (secs % 10 === 0) return `-${secs}s`;
            return '';
          }
        }
      },
      y: {
        beginAtZero: true,
        grid: {
          color: 'rgba(255, 255, 255, 0.04)',
          drawBorder: false
        },
        ticks: {
          color: '#64748b',
          font: { family: 'monospace', size: 10 },
          padding: 6,
          callback: function(value) {
            return formatSpeed(value);
          }
        }
      }
    }
  };
}

// Helper to get client friendly display name
function getClientDisplayName(ip) {
  if (!ip) return 'Неизвестно';
  if (typeof allClients !== 'undefined' && Array.isArray(allClients)) {
    const found = allClients.find(c => c && (c.ip === ip || c.ip === ip.split(':')[0]));
    if (found && found.name) return found.name;
  }
  return ip;
}

// Build datasets for Client Traffic Chart (dedicated or multi-device)
function buildClientChartDatasets(ctx) {
  if (!ctx) return [];
  
  if (selectedTrafficClientIp !== 'ALL') {
    const hist = clientTrafficHistories.get(selectedTrafficClientIp);
    const clientName = hist ? hist.name : getClientDisplayName(selectedTrafficClientIp);
    const vpnDown = hist ? hist.vpnDown : Array(chartDataPointsLimit).fill(0);
    const vpnUp = hist ? hist.vpnUp : Array(chartDataPointsLimit).fill(0);
    const directDown = hist ? hist.directDown : Array(chartDataPointsLimit).fill(0);
    const directUp = hist ? hist.directUp : Array(chartDataPointsLimit).fill(0);

    const vpnDownGrad = ctx.createLinearGradient(0, 0, 0, 240);
    vpnDownGrad.addColorStop(0, 'rgba(56, 189, 248, 0.38)');
    vpnDownGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

    const directDownGrad = ctx.createLinearGradient(0, 0, 0, 240);
    directDownGrad.addColorStop(0, 'rgba(52, 211, 153, 0.38)');
    directDownGrad.addColorStop(1, 'rgba(52, 211, 153, 0.0)');

    return [
      {
        label: `🛡️ ${clientName} — VPN Скачивание (Down)`,
        data: vpnDown,
        borderColor: '#38bdf8',
        backgroundColor: vpnDownGrad,
        fill: true,
        tension: 0.4,
        borderWidth: 2.2,
        pointRadius: 0,
        pointHoverRadius: 5
      },
      {
        label: `🛡️ ${clientName} — VPN Отдача (Up)`,
        data: vpnUp,
        borderColor: '#c084fc',
        borderWidth: 2.0,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 4
      },
      {
        label: `🔌 ${clientName} — DIRECT Скачивание (Down)`,
        data: directDown,
        borderColor: '#34d399',
        backgroundColor: directDownGrad,
        fill: true,
        tension: 0.4,
        borderWidth: 2.2,
        pointRadius: 0,
        pointHoverRadius: 5
      },
      {
        label: `🔌 ${clientName} — DIRECT Отдача (Up)`,
        data: directUp,
        borderColor: '#fbbf24',
        borderWidth: 2.0,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 4
      }
    ];
  }

  // ALL clients view: Show top active devices with distinct color lines
  const datasets = [];
  const entries = Array.from(clientTrafficHistories.values())
    .filter(h => h.vpnDown.some(v => v > 0) || h.directDown.some(v => v > 0) || h.curVpnDown > 0 || h.curDirectDown > 0)
    .sort((a, b) => (b.curVpnDown + b.curDirectDown + b.curVpnUp + b.curDirectUp) - (a.curVpnDown + a.curDirectDown + a.curVpnUp + a.curDirectUp));

  const listToShow = entries.length > 0 ? entries.slice(0, 6) : Array.from(clientTrafficHistories.values()).slice(0, 4);

  listToShow.forEach((hist, idx) => {
    const colors = clientColorPalette[idx % clientColorPalette.length];
    const name = hist.name || hist.ip;
    
    datasets.push({
      label: `🛡️ ${name} (VPN)`,
      data: hist.vpnDown,
      borderColor: colors.vpn,
      borderWidth: 2.2,
      tension: 0.4,
      pointRadius: 0,
      pointHoverRadius: 4
    });
    datasets.push({
      label: `🔌 ${name} (DIRECT)`,
      data: hist.directDown,
      borderColor: colors.direct,
      borderWidth: 2.0,
      borderDash: [5, 4],
      tension: 0.4,
      pointRadius: 0,
      pointHoverRadius: 4
    });
  });

  if (datasets.length === 0) {
    datasets.push({
      label: 'Ожидание трафика подключенных устройств...',
      data: Array(chartDataPointsLimit).fill(0),
      borderColor: 'rgba(255, 255, 255, 0.1)',
      borderWidth: 1,
      pointRadius: 0
    });
  }

  return datasets;
}

// Switch client for device chart
window.setTrafficSelectedClient = function(ip) {
  selectedTrafficClientIp = ip || 'ALL';
  const selectEl = document.getElementById('traffic-client-select');
  if (selectEl && selectEl.value !== selectedTrafficClientIp) {
    selectEl.value = selectedTrafficClientIp;
  }
  
  const canvas = document.getElementById('traffic-chart-clients');
  if (canvas && trafficChartClients) {
    const ctx = canvas.getContext('2d');
    trafficChartClients.data.datasets = buildClientChartDatasets(ctx);
    trafficChartClients.update();
  }
  updateClientsTrafficUI();
};

// Helper for stable device sorting (by IP / name) so buttons NEVER jump or shuffle
function sortClientsStably(a, b) {
  if (!a || !b) return 0;
  const aIpParts = (a.ip || '').split('.').map(p => parseInt(p, 10) || 0);
  const bIpParts = (b.ip || '').split('.').map(p => parseInt(p, 10) || 0);
  if (aIpParts.length === 4 && bIpParts.length === 4) {
    for (let i = 0; i < 4; i++) {
      if (aIpParts[i] !== bIpParts[i]) return aIpParts[i] - bIpParts[i];
    }
  }
  return (a.name || a.ip || '').localeCompare(b.name || b.ip || '');
}

function updateClientsTrafficUI() {
  // 1. Update live speed indicator in header
  const speedLabel = document.getElementById('subchart-client-speed');
  if (speedLabel) {
    if (selectedTrafficClientIp !== 'ALL') {
      const hist = clientTrafficHistories.get(selectedTrafficClientIp);
      if (hist) {
        speedLabel.innerHTML = `🛡️ VPN: <span style="color:#38bdf8">⬇️ ${formatSpeed(hist.curVpnDown)}</span> <span style="color:#c084fc">⬆️ ${formatSpeed(hist.curVpnUp)}</span> &nbsp;•&nbsp; 🔌 Direct: <span style="color:#34d399">⬇️ ${formatSpeed(hist.curDirectDown)}</span> <span style="color:#fbbf24">⬆️ ${formatSpeed(hist.curDirectUp)}</span>`;
      } else {
        speedLabel.textContent = '🛡️ VPN: 0 Кбит/с • 🔌 Direct: 0 Кбит/с';
      }
    } else {
      let sumVpnDown = 0, sumVpnUp = 0, sumDirDown = 0, sumDirUp = 0;
      for (const h of clientTrafficHistories.values()) {
        sumVpnDown += h.curVpnDown;
        sumVpnUp += h.curVpnUp;
        sumDirDown += h.curDirectDown;
        sumDirUp += h.curDirectUp;
      }
      speedLabel.innerHTML = `🛡️ VPN: <span style="color:#38bdf8">⬇️ ${formatSpeed(sumVpnDown)}</span> &nbsp;•&nbsp; 🔌 Direct: <span style="color:#34d399">⬇️ ${formatSpeed(sumDirDown)}</span>`;
    }
  }

  // Filter out internal loopback
  const clientEntries = Array.from(clientTrafficHistories.values())
    .filter(h => h.ip !== '127.0.0.1' && h.ip !== '::1')
    .sort(sortClientsStably);

  // 2. Update Select Dropdown stably without resetting or jumping
  const selectEl = document.getElementById('traffic-client-select');
  if (selectEl) {
    const currentVal = selectedTrafficClientIp;
    const currentOptionsCount = selectEl.options.length;
    const neededOptionsCount = 1 + clientEntries.length;

    let shouldRebuild = currentOptionsCount !== neededOptionsCount;
    if (!shouldRebuild) {
      for (let i = 0; i < clientEntries.length; i++) {
        if (!selectEl.options[i + 1] || selectEl.options[i + 1].value !== clientEntries[i].ip) {
          shouldRebuild = true;
          break;
        }
      }
    }

    if (shouldRebuild) {
      selectEl.innerHTML = '<option value="ALL">📊 Все активные устройства (Сводный)</option>';
      clientEntries.forEach(h => {
        const opt = document.createElement('option');
        opt.value = h.ip;
        opt.textContent = `💻 ${h.name} (${h.ip})`;
        selectEl.appendChild(opt);
      });
      selectEl.value = currentVal;
    }
  }

  // 3. Update Device Chips in-place (Static width, zero layout shifts!)
  const chipsContainer = document.getElementById('traffic-clients-chips-container');
  if (chipsContainer) {
    if (clientEntries.length === 0) {
      chipsContainer.innerHTML = '<span style="font-size: 0.78rem; color: var(--text-muted); padding: 4px 0;">Ожидание активных сетевых соединений от устройств...</span>';
    } else {
      const existingChips = Array.from(chipsContainer.querySelectorAll('.traffic-client-chip[data-chip-ip]'));
      const canUpdateInPlace = existingChips.length === clientEntries.length &&
        existingChips.every((chip, idx) => chip.getAttribute('data-chip-ip') === clientEntries[idx].ip);

      if (canUpdateInPlace) {
        // In-place update: update dot status & active class only (ZERO width change!)
        const allChip = chipsContainer.querySelector('.traffic-client-chip-all');
        if (allChip) {
          if (selectedTrafficClientIp === 'ALL') allChip.classList.add('active');
          else allChip.classList.remove('active');
        }

        clientEntries.forEach((h, idx) => {
          const chip = existingChips[idx];
          if (!chip) return;
          const isActive = selectedTrafficClientIp === h.ip;
          if (isActive) chip.classList.add('active');
          else chip.classList.remove('active');

          const totVpn = h.curVpnDown + h.curVpnUp;
          const totDirect = h.curDirectDown + h.curDirectUp;

          const dot = chip.querySelector('.chip-dot');
          if (dot) {
            dot.className = 'chip-dot';
            if (totVpn > 0 && totDirect > 0) dot.classList.add('active-both');
            else if (totVpn > 0) dot.classList.add('active-vpn');
            else if (totDirect > 0) dot.classList.add('active-direct');
          }
        });
      } else {
        // Initial build in stable fixed order with static width
        let html = `<div class="traffic-client-chip traffic-client-chip-all ${selectedTrafficClientIp === 'ALL' ? 'active' : ''}" onclick="setTrafficSelectedClient('ALL')">
          <span class="chip-dot active-both"></span>
          <span class="chip-name">📊 Все устройства</span>
        </div>`;

        clientEntries.forEach(h => {
          const isActive = selectedTrafficClientIp === h.ip;
          const totVpn = h.curVpnDown + h.curVpnUp;
          const totDirect = h.curDirectDown + h.curDirectUp;
          let dotClass = 'chip-dot';
          if (totVpn > 0 && totDirect > 0) dotClass += ' active-both';
          else if (totVpn > 0) dotClass += ' active-vpn';
          else if (totDirect > 0) dotClass += ' active-direct';

          html += `<div class="traffic-client-chip ${isActive ? 'active' : ''}" data-chip-ip="${h.ip}" onclick="setTrafficSelectedClient('${h.ip}')">
            <span class="${dotClass}"></span>
            <span class="chip-name">💻 ${h.name}</span>
          </div>`;
        });

        chipsContainer.innerHTML = html;
      }
    }
  }
}

// --- 1. Real-time Traffic Graph Mode Switcher & Initializer ---
window.setTrafficChartMode = function(mode) {
  trafficChartMode = mode;
  
  // Update button classes
  ['split', 'combined', 'vpn', 'direct'].forEach(m => {
    const btn = document.getElementById(`tmt-${m}`);
    if (btn) {
      if (m === mode) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  });

  const splitView = document.getElementById('traffic-split-view');
  const singleView = document.getElementById('traffic-single-view');

  if (mode === 'split') {
    if (splitView) {
      splitView.style.display = 'grid';
      splitView.classList.remove('view-hidden');
      splitView.classList.add('view-visible');
    }
    if (singleView) {
      singleView.style.display = 'none';
      singleView.classList.remove('view-visible');
      singleView.classList.add('view-hidden');
    }
  } else {
    if (splitView) {
      splitView.style.display = 'none';
      splitView.classList.remove('view-visible');
      splitView.classList.add('view-hidden');
    }
    if (singleView) {
      singleView.style.display = 'block';
      singleView.classList.remove('view-hidden');
      singleView.classList.add('view-visible');
    }
  }

  // Destroy single chart if mode changed to re-init with right datasets
  if (trafficChart) {
    trafficChart.destroy();
    trafficChart = null;
  }
  
  initAllTrafficCharts();
  updateAllTrafficCharts();
};

function initAllTrafficCharts() {
  if (typeof Chart === 'undefined') return;

  // 1. Dedicated VPN Chart (in Split View)
  const vpnCanvas = document.getElementById('traffic-chart-vpn');
  if (vpnCanvas && !trafficChartVPN) {
    const ctx = vpnCanvas.getContext('2d');
    const downGrad = ctx.createLinearGradient(0, 0, 0, 240);
    downGrad.addColorStop(0, 'rgba(56, 189, 248, 0.38)');
    downGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

    const upGrad = ctx.createLinearGradient(0, 0, 0, 240);
    upGrad.addColorStop(0, 'rgba(192, 132, 252, 0.38)');
    upGrad.addColorStop(1, 'rgba(192, 132, 252, 0.0)');

    trafficChartVPN = new Chart(ctx, {
      type: 'line',
      data: {
        labels: trafficLabels,
        datasets: [
          {
            label: 'VPN Скачивание (Down)',
            data: vpnDownloadHistory,
            borderColor: '#38bdf8',
            backgroundColor: downGrad,
            fill: true,
            tension: 0.4,
            borderWidth: 2.2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBorderWidth: 2,
            pointHoverBackgroundColor: '#0f172a',
            pointHoverBorderColor: '#38bdf8'
          },
          {
            label: 'VPN Отдача (Up)',
            data: vpnUploadHistory,
            borderColor: '#c084fc',
            backgroundColor: upGrad,
            fill: true,
            tension: 0.4,
            borderWidth: 2.2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBorderWidth: 2,
            pointHoverBackgroundColor: '#0f172a',
            pointHoverBorderColor: '#c084fc'
          }
        ]
      },
      options: buildTrafficChartOptions('VPN Traffic')
    });
  }

  // 2. Dedicated DIRECT Chart (in Split View)
  const directCanvas = document.getElementById('traffic-chart-direct');
  if (directCanvas && !trafficChartDirect) {
    const ctx = directCanvas.getContext('2d');
    const downGrad = ctx.createLinearGradient(0, 0, 0, 240);
    downGrad.addColorStop(0, 'rgba(52, 211, 153, 0.38)');
    downGrad.addColorStop(1, 'rgba(52, 211, 153, 0.0)');

    const upGrad = ctx.createLinearGradient(0, 0, 0, 240);
    upGrad.addColorStop(0, 'rgba(251, 191, 36, 0.38)');
    upGrad.addColorStop(1, 'rgba(251, 191, 36, 0.0)');

    trafficChartDirect = new Chart(ctx, {
      type: 'line',
      data: {
        labels: trafficLabels,
        datasets: [
          {
            label: 'DIRECT Скачивание (Down)',
            data: directDownloadHistory,
            borderColor: '#34d399',
            backgroundColor: downGrad,
            fill: true,
            tension: 0.4,
            borderWidth: 2.2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBorderWidth: 2,
            pointHoverBackgroundColor: '#0f172a',
            pointHoverBorderColor: '#34d399'
          },
          {
            label: 'DIRECT Отдача (Up)',
            data: directUploadHistory,
            borderColor: '#fbbf24',
            backgroundColor: upGrad,
            fill: true,
            tension: 0.4,
            borderWidth: 2.2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBorderWidth: 2,
            pointHoverBackgroundColor: '#0f172a',
            pointHoverBorderColor: '#fbbf24'
          }
        ]
      },
      options: buildTrafficChartOptions('DIRECT Traffic')
    });
  }

  // 3. Dedicated Per-Device Chart (in Split View)
  const clientCanvas = document.getElementById('traffic-chart-clients');
  if (clientCanvas && !trafficChartClients && trafficChartMode === 'split') {
    const ctx = clientCanvas.getContext('2d');
    trafficChartClients = new Chart(ctx, {
      type: 'line',
      data: {
        labels: trafficLabels,
        datasets: buildClientChartDatasets(ctx)
      },
      options: buildTrafficChartOptions('Client Traffic')
    });
  }

  // 4. Combined / Single Chart (in Single View)
  const singleCanvas = document.getElementById('traffic-speed-chart');
  if (singleCanvas && !trafficChart && trafficChartMode !== 'split') {
    const ctx = singleCanvas.getContext('2d');
    let datasets = [];

    if (trafficChartMode === 'combined') {
      const vpnDownGrad = ctx.createLinearGradient(0, 0, 0, 320);
      vpnDownGrad.addColorStop(0, 'rgba(56, 189, 248, 0.3)');
      vpnDownGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

      const directDownGrad = ctx.createLinearGradient(0, 0, 0, 320);
      directDownGrad.addColorStop(0, 'rgba(52, 211, 153, 0.3)');
      directDownGrad.addColorStop(1, 'rgba(52, 211, 153, 0.0)');

      datasets = [
        {
          label: '🛡️ VPN Скачивание',
          data: vpnDownloadHistory,
          borderColor: '#38bdf8',
          backgroundColor: vpnDownGrad,
          fill: true,
          tension: 0.4,
          borderWidth: 2.4,
          pointRadius: 0
        },
        {
          label: '🛡️ VPN Отдача',
          data: vpnUploadHistory,
          borderColor: '#c084fc',
          borderWidth: 2.2,
          tension: 0.4,
          pointRadius: 0
        },
        {
          label: '🔌 DIRECT Скачивание',
          data: directDownloadHistory,
          borderColor: '#34d399',
          backgroundColor: directDownGrad,
          fill: true,
          tension: 0.4,
          borderWidth: 2.4,
          pointRadius: 0
        },
        {
          label: '🔌 DIRECT Отдача',
          data: directUploadHistory,
          borderColor: '#fbbf24',
          borderWidth: 2.2,
          tension: 0.4,
          pointRadius: 0
        }
      ];
    } else if (trafficChartMode === 'vpn') {
      const vpnDownGrad = ctx.createLinearGradient(0, 0, 0, 320);
      vpnDownGrad.addColorStop(0, 'rgba(56, 189, 248, 0.38)');
      vpnDownGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

      datasets = [
        {
          label: '🛡️ VPN Скачивание',
          data: vpnDownloadHistory,
          borderColor: '#38bdf8',
          backgroundColor: vpnDownGrad,
          fill: true,
          tension: 0.4,
          borderWidth: 2.5,
          pointRadius: 0
        },
        {
          label: '🛡️ VPN Отдача',
          data: vpnUploadHistory,
          borderColor: '#c084fc',
          borderWidth: 2.5,
          tension: 0.4,
          pointRadius: 0
        }
      ];
    } else if (trafficChartMode === 'direct') {
      const directDownGrad = ctx.createLinearGradient(0, 0, 0, 320);
      directDownGrad.addColorStop(0, 'rgba(52, 211, 153, 0.38)');
      directDownGrad.addColorStop(1, 'rgba(52, 211, 153, 0.0)');

      datasets = [
        {
          label: '🔌 DIRECT Скачивание',
          data: directDownloadHistory,
          borderColor: '#34d399',
          backgroundColor: directDownGrad,
          fill: true,
          tension: 0.4,
          borderWidth: 2.5,
          pointRadius: 0
        },
        {
          label: '🔌 DIRECT Отдача',
          data: directUploadHistory,
          borderColor: '#fbbf24',
          borderWidth: 2.5,
          tension: 0.4,
          pointRadius: 0
        }
      ];
    }

    trafficChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: trafficLabels,
        datasets: datasets
      },
      options: buildTrafficChartOptions('Combined Traffic')
    });
  }
}

function updateAllTrafficCharts() {
  if (currentTab !== 'traffic') return;
  if (trafficChartVPN) trafficChartVPN.update('none');
  if (trafficChartDirect) trafficChartDirect.update('none');
  if (trafficChartClients) {
    const clientCanvas = document.getElementById('traffic-chart-clients');
    if (clientCanvas) {
      const ctx = clientCanvas.getContext('2d');
      trafficChartClients.data.datasets = buildClientChartDatasets(ctx);
      trafficChartClients.update('none');
    }
  }
  if (trafficChart) trafficChart.update('none');
}

function startTrafficStream() {
  if (trafficAbortController) return; // Stream is already active in background
  
  const statusEl = document.getElementById('traffic-status');
  
  // We also poll connections in the background to calculate volume stats & speed splits
  startConnectionsPolling(true); // silent background poll
  
  trafficAbortController = new AbortController();
  
  async function runStream() {
    while (trafficAbortController && !trafficAbortController.signal.aborted) {
      if (statusEl) statusEl.textContent = 'Подключение...';
      try {
        await readHttpStream('/api/xkeen/traffic', (data) => {
          if (statusEl) statusEl.textContent = '● LIVE';
          
          // Compute proportional split between VPN and DIRECT
          const totInstDown = instVpnDown + instDirectDown;
          const ratioDown = totInstDown > 0 ? (instVpnDown / totInstDown) : (directDownloadAccum > 0 && vpnDownloadAccum === 0 ? 0 : 0.85);
          const curVpnDown = Math.min(data.down, Math.round(data.down * ratioDown));
          const curDirectDown = Math.max(0, data.down - curVpnDown);

          const totInstUp = instVpnUp + instDirectUp;
          const ratioUp = totInstUp > 0 ? (instVpnUp / totInstUp) : (directUploadAccum > 0 && vpnUploadAccum === 0 ? 0 : 0.85);
          const curVpnUp = Math.min(data.up, Math.round(data.up * ratioUp));
          const curDirectUp = Math.max(0, data.up - curVpnUp);

          // Shift history values
          trafficDownloadHistory.shift();
          trafficDownloadHistory.push(data.down);
          trafficUploadHistory.shift();
          trafficUploadHistory.push(data.up);

          vpnDownloadHistory.shift();
          vpnDownloadHistory.push(curVpnDown);
          vpnUploadHistory.shift();
          vpnUploadHistory.push(curVpnUp);

          directDownloadHistory.shift();
          directDownloadHistory.push(curDirectDown);
          directUploadHistory.shift();
          directUploadHistory.push(curDirectUp);

          if (data.down > peakDownloadSpeed) {
            peakDownloadSpeed = data.down;
            const peakEl = document.getElementById('speed-download-peak');
            if (peakEl) peakEl.textContent = 'Пик: ' + formatSpeed(peakDownloadSpeed);
          }
          if (data.up > peakUploadSpeed) {
            peakUploadSpeed = data.up;
            const peakEl = document.getElementById('speed-upload-peak');
            if (peakEl) peakEl.textContent = 'Пик: ' + formatSpeed(peakUploadSpeed);
          }
          
          // Update labels and chart only if currently viewing Traffic tab
          if (currentTab === 'traffic') {
            const speedDownEl = document.getElementById('speed-download');
            const speedUpEl = document.getElementById('speed-upload');
            if (speedDownEl) speedDownEl.textContent = formatSpeed(data.down);
            if (speedUpEl) speedUpEl.textContent = formatSpeed(data.up);

            const vpnSpeedSub = document.getElementById('speed-vpn-current');
            const directSpeedSub = document.getElementById('speed-direct-current');
            if (vpnSpeedSub) vpnSpeedSub.textContent = `⬇️ ${formatSpeed(curVpnDown)}  ⬆️ ${formatSpeed(curVpnUp)}`;
            if (directSpeedSub) directSpeedSub.textContent = `⬇️ ${formatSpeed(curDirectDown)}  ⬆️ ${formatSpeed(curDirectUp)}`;

            const subchartVpnSpeed = document.getElementById('subchart-vpn-speed');
            const subchartDirectSpeed = document.getElementById('subchart-direct-speed');
            if (subchartVpnSpeed) subchartVpnSpeed.textContent = `⬇️ ${formatSpeed(curVpnDown)} • ⬆️ ${formatSpeed(curVpnUp)}`;
            if (subchartDirectSpeed) subchartDirectSpeed.textContent = `⬇️ ${formatSpeed(curDirectDown)} • ⬆️ ${formatSpeed(curDirectUp)}`;
            
            initAllTrafficCharts();
            updateAllTrafficCharts();
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
    
    // Aggregate VPN vs DIRECT traffic volumes & calculate instant speed
    updateTrafficVolumes(connections);
    
    // Process packet log entries for Packet Monitor tab
    processPacketLogEntries(connections);
    
    const connectionsTabEl = document.getElementById('tab-content-connections');
    const isConnectionsTabActive = connectionsTabEl && connectionsTabEl.classList.contains('active');
    
    // If not currently viewing connections or packet-monitor, and in silent mode, skip table rendering
    if (!isConnectionsTabActive && connectionsSilentMode && currentTab !== 'packet-monitor' && currentTab !== 'connections') return;
    
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
  const now = Date.now();
  const dt = Math.max(0.5, (now - lastVolumeCheckTime) / 1000);
  lastVolumeCheckTime = now;

  const currentIds = new Set();
  let stepVpnDown = 0;
  let stepVpnUp = 0;
  let stepDirectDown = 0;
  let stepDirectUp = 0;

  // Track per-client step bytes
  const clientSteps = new Map(); // ip => { vpnDown: 0, vpnUp: 0, directDown: 0, directUp: 0 }
  
  for (const conn of connectionsList) {
    if (!conn) continue;
    currentIds.add(conn.id);
    // Determine if connection goes direct
    const isDirect = conn.chains.includes('DIRECT') || (conn.chains.length > 0 && conn.chains[conn.chains.length - 1].toLowerCase() === 'direct');
    
    // Extract source IP
    let srcIp = '127.0.0.1';
    if (conn.metadata && conn.metadata.sourceIP) {
      srcIp = conn.metadata.sourceIP.replace(/^::ffff:/, '').split(':')[0];
    }
    if (!srcIp || srcIp === '::' || srcIp === '0.0.0.0') srcIp = '127.0.0.1';

    if (!clientSteps.has(srcIp)) {
      clientSteps.set(srcIp, { vpnDown: 0, vpnUp: 0, directDown: 0, directUp: 0 });
    }
    const cStep = clientSteps.get(srcIp);

    const lastState = activeConnectionsMap.get(conn.id);
    if (lastState) {
      const downDiff = Math.max(0, conn.download - lastState.download);
      const upDiff = Math.max(0, conn.upload - lastState.upload);
      
      if (isDirect) {
        directDownloadAccum += downDiff;
        directUploadAccum += upDiff;
        stepDirectDown += downDiff;
        stepDirectUp += upDiff;
        cStep.directDown += downDiff;
        cStep.directUp += upDiff;
      } else {
        vpnDownloadAccum += downDiff;
        vpnUploadAccum += upDiff;
        stepVpnDown += downDiff;
        stepVpnUp += upDiff;
        cStep.vpnDown += downDiff;
        cStep.vpnUp += upDiff;
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
      isDirect,
      srcIp
    });
  }
  
  // Compute instant rates (bytes/sec)
  instVpnDown = Math.round(stepVpnDown / dt);
  instVpnUp = Math.round(stepVpnUp / dt);
  instDirectDown = Math.round(stepDirectDown / dt);
  instDirectUp = Math.round(stepDirectUp / dt);

  // Update client histories
  const seenClientIps = new Set();
  for (const [ip, step] of clientSteps.entries()) {
    seenClientIps.add(ip);
    const curVpnDown = Math.round(step.vpnDown / dt);
    const curVpnUp = Math.round(step.vpnUp / dt);
    const curDirectDown = Math.round(step.directDown / dt);
    const curDirectUp = Math.round(step.directUp / dt);

    let hist = clientTrafficHistories.get(ip);
    if (!hist) {
      hist = {
        ip,
        name: getClientDisplayName(ip),
        vpnDown: Array(chartDataPointsLimit).fill(0),
        vpnUp: Array(chartDataPointsLimit).fill(0),
        directDown: Array(chartDataPointsLimit).fill(0),
        directUp: Array(chartDataPointsLimit).fill(0),
        curVpnDown: 0,
        curVpnUp: 0,
        curDirectDown: 0,
        curDirectUp: 0,
        lastSeen: now
      };
      clientTrafficHistories.set(ip, hist);
    }

    hist.name = getClientDisplayName(ip);
    hist.curVpnDown = curVpnDown;
    hist.curVpnUp = curVpnUp;
    hist.curDirectDown = curDirectDown;
    hist.curDirectUp = curDirectUp;
    hist.lastSeen = now;

    hist.vpnDown.shift();
    hist.vpnDown.push(curVpnDown);
    hist.vpnUp.shift();
    hist.vpnUp.push(curVpnUp);
    hist.directDown.shift();
    hist.directDown.push(curDirectDown);
    hist.directUp.shift();
    hist.directUp.push(curDirectUp);
  }

  // Also include known clients from allClients if not in connections
  if (typeof allClients !== 'undefined' && Array.isArray(allClients)) {
    allClients.forEach(c => {
      if (c && c.ip && !clientTrafficHistories.has(c.ip)) {
        clientTrafficHistories.set(c.ip, {
          ip: c.ip,
          name: c.name || c.ip,
          vpnDown: Array(chartDataPointsLimit).fill(0),
          vpnUp: Array(chartDataPointsLimit).fill(0),
          directDown: Array(chartDataPointsLimit).fill(0),
          directUp: Array(chartDataPointsLimit).fill(0),
          curVpnDown: 0,
          curVpnUp: 0,
          curDirectDown: 0,
          curDirectUp: 0,
          lastSeen: 0
        });
      }
    });
  }

  // Shift 0 for clients without traffic in this tick
  for (const [ip, hist] of clientTrafficHistories.entries()) {
    if (!seenClientIps.has(ip)) {
      hist.curVpnDown = 0;
      hist.curVpnUp = 0;
      hist.curDirectDown = 0;
      hist.curDirectUp = 0;
      hist.vpnDown.shift();
      hist.vpnDown.push(0);
      hist.vpnUp.shift();
      hist.vpnUp.push(0);
      hist.directDown.shift();
      hist.directDown.push(0);
      hist.directUp.shift();
      hist.directUp.push(0);
    }
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

  // Update client UI & chart
  updateClientsTrafficUI();
  if (trafficChartClients && currentTab === 'traffic' && trafficChartMode === 'split') {
    const clientCanvas = document.getElementById('traffic-chart-clients');
    if (clientCanvas) {
      const ctx = clientCanvas.getContext('2d');
      trafficChartClients.data.datasets = buildClientChartDatasets(ctx);
      trafficChartClients.update('none');
    }
  }
}

function renderConnectionsTable(connections) {
  const tbody = document.getElementById('connections-list');
  if (!tbody) return;
  
  const searchInput = document.getElementById('conn-search-box');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  
  const filtered = (connections || []).filter(c => {
    if (!c) return false;
    const meta = c.metadata || {};
    const host = (meta.host || meta.destinationIP || '').toLowerCase();
    const srcIp = (meta.sourceIP || '').toLowerCase();
    const rule = (c.rule || '').toLowerCase();
    const chain = (c.chains || []).join(' ').toLowerCase();
    if (!query) return true;
    return host.includes(query) || srcIp.includes(query) || rule.includes(query) || chain.includes(query);
  });
  
  tbody.innerHTML = '';
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 32px;">' +
      (query ? 'Ничего не найдено по запросу "' + query + '"' : 'Активные сетевые соединения отсутствуют') +
      '</td></tr>';
    return;
  }
  
  const now = Date.now();
  const newBytesMap = new Map();
  const frag = document.createDocumentFragment();
  
  filtered.forEach(c => {
    if (!c) return;
    const meta = c.metadata || {};
    const tr = document.createElement('tr');
    
    // Source
    const tdSrc = document.createElement('td');
    tdSrc.textContent = (meta.sourceIP || '0.0.0.0') + ':' + (meta.sourcePort || '0');
    
    // Destination
    const tdDest = document.createElement('td');
    tdDest.style.maxWidth = '260px';
    tdDest.style.overflow = 'hidden';
    tdDest.style.textOverflow = 'ellipsis';
    tdDest.style.whiteSpace = 'nowrap';
    const destHost = meta.host || meta.destinationIP || 'Неизвестно';
    const destPort = meta.destinationPort ? ':' + meta.destinationPort : '';
    tdDest.textContent = destHost + destPort;
    tdDest.title = destHost + destPort;
    
    // Protocol
    const tdProto = document.createElement('td');
    const netType = (meta.network || 'TCP').toUpperCase();
    tdProto.innerHTML = `<span class="route-badge">${netType}</span>`;
    
    // Rule
    const tdRule = document.createElement('td');
    tdRule.style.maxWidth = '240px';
    tdRule.style.overflow = 'hidden';
    tdRule.style.textOverflow = 'ellipsis';
    tdRule.style.whiteSpace = 'nowrap';
    const ruleText = (c.rule || 'DIRECT') + (c.rulePayload ? ' (' + c.rulePayload + ')' : '');
    tdRule.textContent = ruleText;
    tdRule.title = ruleText;
    
    // Chains
    const tdChains = document.createElement('td');
    tdChains.style.maxWidth = '260px';
    tdChains.style.overflow = 'hidden';
    tdChains.style.textOverflow = 'ellipsis';
    tdChains.style.whiteSpace = 'nowrap';
    tdChains.style.fontSize = '0.88rem';
    const chainsArr = Array.isArray(c.chains) ? c.chains : [];
    const chainsText = chainsArr.length > 0 ? chainsArr.join(' ➔ ') : 'DIRECT';
    tdChains.textContent = chainsText;
    tdChains.title = chainsText;
    
    // Traffic & Speed
    const tdTraffic = document.createElement('td');
    const downBytes = c.download || 0;
    const upBytes = c.upload || 0;
    const totalBytes = downBytes + upBytes;
    let speedText = '';
    
    const prev = lastConnBytesMap.get(c.id);
    if (prev) {
      const timeDiff = (now - prev.time) / 1000;
      if (timeDiff > 0) {
        const downDiff = Math.max(0, downBytes - prev.download);
        const upDiff = Math.max(0, upBytes - prev.upload);
        const speed = (downDiff + upDiff) / timeDiff;
        if (speed > 100) {
          speedText = ` (⚡ ${formatSpeed(speed)})`;
        }
      }
    }
    newBytesMap.set(c.id, { download: downBytes, upload: upBytes, time: now });
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
          showToast('Соединение разорвано');
          loadConnections();
        } else {
          showToast('Ошибка разрыва соединения', 'error');
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
    
    frag.appendChild(tr);
  });
  
  tbody.appendChild(frag);
  lastConnBytesMap = newBytesMap;
}

// ==========================================
// --- 2.1 Packet Monitor (Live Process & Packet Tracking) ---
// ==========================================
let packetLogs = [];
let packetStreamActive = true;
let knownProcesses = new Set();
let seenPacketConnIds = new Map();

function getProcessColor(processName) {
  if (!processName) processName = 'Direct / General';
  const cleanName = processName.toLowerCase().replace(/\.exe$/, '').trim();
  
  const presets = {
    'google': { bg: 'rgba(66, 133, 244, 0.15)', border: '#4285F4', text: '#90CAF9' },
    'apple': { bg: 'rgba(255, 255, 255, 0.15)', border: '#EEEEEE', text: '#FFFFFF' },
    'telegram': { bg: 'rgba(34, 158, 217, 0.15)', border: '#229ED9', text: '#76CEF4' },
    'youtube': { bg: 'rgba(255, 23, 68, 0.15)', border: '#FF1744', text: '#FF8A80' },
    'discord': { bg: 'rgba(88, 101, 242, 0.15)', border: '#5865F2', text: '#B388FF' },
    'tiktok': { bg: 'rgba(254, 44, 85, 0.15)', border: '#FE2C55', text: '#FF80AB' },
    'meta / ig': { bg: 'rgba(225, 48, 108, 0.15)', border: '#E1306C', text: '#FF80AB' },
    'meta': { bg: 'rgba(225, 48, 108, 0.15)', border: '#E1306C', text: '#FF80AB' },
    'steam': { bg: 'rgba(102, 192, 244, 0.15)', border: '#66C0F4', text: '#80D8FF' },
    'spotify': { bg: 'rgba(30, 215, 96, 0.15)', border: '#1ED760', text: '#B9F6CA' },
    'netflix': { bg: 'rgba(229, 9, 20, 0.15)', border: '#E50914', text: '#FF8A80' },
    'roblox': { bg: 'rgba(0, 162, 232, 0.15)', border: '#00A2E8', text: '#80D8FF' },
    'github': { bg: 'rgba(156, 39, 176, 0.15)', border: '#AB47BC', text: '#EA80FC' },
    'openai': { bg: 'rgba(16, 163, 127, 0.15)', border: '#10A37F', text: '#A7F3D0' },
    'anthropic': { bg: 'rgba(217, 119, 6, 0.15)', border: '#D97706', text: '#FDE68A' },
    'twitter / x': { bg: 'rgba(29, 155, 240, 0.15)', border: '#1D9BF0', text: '#80D8FF' },
    'bittorrent': { bg: 'rgba(255, 152, 0, 0.15)', border: '#FF9800', text: '#FFE082' },
    'rutracker': { bg: 'rgba(255, 152, 0, 0.15)', border: '#FF9800', text: '#FFE082' },
    'yandex': { bg: 'rgba(255, 204, 0, 0.15)', border: '#FFCC00', text: '#FFF59D' },
    'vkontakte': { bg: 'rgba(0, 119, 255, 0.15)', border: '#0077FF', text: '#82B1FF' },
    'direct / general': { bg: 'rgba(76, 175, 80, 0.15)', border: '#4CAF50', text: '#A5D6A7' }
  };

  if (presets[cleanName]) return presets[cleanName];

  let hash = 0;
  for (let i = 0; i < cleanName.length; i++) {
    hash = cleanName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return {
    bg: `hsla(${hue}, 85%, 60%, 0.15)`,
    border: `hsl(${hue}, 85%, 60%)`,
    text: `hsl(${hue}, 90%, 75%)`
  };
}

function extractProcessName(conn) {
  const payload = (conn.rulePayload || '').toLowerCase();
  const host = (conn.metadata && conn.metadata.host ? conn.metadata.host : '').toLowerCase();
  const chainsStr = (conn.chains ? conn.chains.join(' ') : '').toLowerCase();

  if (payload.includes('google') || host.includes('google') || host.includes('gstatic') || host.includes('ggpht') || chainsStr.includes('google')) return 'Google';
  if (payload.includes('apple') || host.includes('apple') || host.includes('icloud') || chainsStr.includes('apple')) return 'Apple';
  if (payload.includes('telegram') || host.includes('telegram') || host.includes('t.me') || chainsStr.includes('telegram')) return 'Telegram';
  if (payload.includes('youtube') || host.includes('youtube') || host.includes('googlevideo') || chainsStr.includes('youtube')) return 'YouTube';
  if (payload.includes('discord') || host.includes('discord') || chainsStr.includes('discord')) return 'Discord';
  if (payload.includes('tiktok') || host.includes('tiktok') || host.includes('byteoversea') || chainsStr.includes('tiktok')) return 'TikTok';
  if (payload.includes('meta') || payload.includes('instagram') || payload.includes('facebook') || host.includes('instagram') || host.includes('facebook') || chainsStr.includes('meta')) return 'Meta / IG';
  if (payload.includes('steam') || host.includes('steam') || chainsStr.includes('steam')) return 'Steam';
  if (payload.includes('spotify') || host.includes('spotify') || chainsStr.includes('spotify')) return 'Spotify';
  if (payload.includes('netflix') || host.includes('netflix') || chainsStr.includes('netflix')) return 'Netflix';
  if (payload.includes('roblox') || host.includes('roblox') || chainsStr.includes('roblox')) return 'Roblox';
  if (payload.includes('github') || host.includes('github') || chainsStr.includes('github')) return 'GitHub';
  if (payload.includes('openai') || payload.includes('chatgpt') || host.includes('openai') || chainsStr.includes('openai')) return 'OpenAI';
  if (payload.includes('anthropic') || host.includes('anthropic') || chainsStr.includes('anthropic')) return 'Anthropic';
  if (payload.includes('twitter') || payload.includes('x.com') || host.includes('twitter') || host.includes('x.com')) return 'Twitter / X';
  if (payload.includes('torrent') || host.includes('torrent') || host.includes('tracker')) return 'BitTorrent';
  if (payload.includes('rutracker') || host.includes('rutracker')) return 'RuTracker';
  if (payload.includes('kinopoisk') || host.includes('kinopoisk')) return 'KinoPoisk';
  if (payload.includes('yandex') || host.includes('yandex')) return 'Yandex';
  if (payload.includes('vk') || host.includes('vk.com') || host.includes('vkuser')) return 'VKontakte';

  if (conn.rulePayload && !conn.rulePayload.includes(':') && !conn.rulePayload.includes('/') && conn.rulePayload.length < 25) {
    return conn.rulePayload.charAt(0).toUpperCase() + conn.rulePayload.slice(1);
  }

  if (conn.chains && conn.chains.length > 0) {
    const firstGroup = conn.chains[0];
    if (firstGroup && firstGroup !== 'GLOBAL' && firstGroup !== 'DIRECT') {
      return firstGroup;
    }
  }

  if (host && host.includes('.')) {
    const parts = host.split('.');
    const mainDomain = parts[parts.length - 2];
    if (mainDomain && mainDomain.length > 2 && !/^\d+$/.test(mainDomain)) {
      return mainDomain.charAt(0).toUpperCase() + mainDomain.slice(1);
    }
  }

  if (conn.metadata && conn.metadata.processPath) {
    const parts = conn.metadata.processPath.split(/[/\\]/);
    return parts[parts.length - 1];
  }
  if (conn.metadata && conn.metadata.process) {
    return conn.metadata.process;
  }

  return 'Direct / General';
}

function processPacketLogEntries(connections) {
  let totalDown = 0;
  let totalUp = 0;

  for (const conn of connections) {
    totalDown += (conn.download || 0);
    totalUp += (conn.upload || 0);
    
    const procName = extractProcessName(conn);
    if (!knownProcesses.has(procName)) {
      knownProcesses.add(procName);
      updateProcessFilterDropdown();
    }

    if (!seenPacketConnIds.has(conn.id)) {
      const now = new Date();
      const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0').substring(0, 2);
      seenPacketConnIds.set(conn.id, timeStr);

      if (packetStreamActive) {
        const dest = (conn.metadata && conn.metadata.host) 
          ? `${conn.metadata.host}:${conn.metadata.destinationPort}` 
          : `${conn.metadata ? conn.metadata.destinationIP : 'unknown'}:${conn.metadata ? conn.metadata.destinationPort : ''}`;
        
        const src = conn.metadata ? `${conn.metadata.sourceIP}:${conn.metadata.sourcePort}` : 'local';
        const proto = conn.metadata ? (conn.metadata.network || 'TCP').toUpperCase() : 'TCP';
        const chainStr = conn.chains ? conn.chains.join(' ➔ ') : (conn.rule || 'DIRECT');

        const entry = {
          id: conn.id,
          time: timeStr,
          process: procName,
          protocol: proto,
          source: src,
          destination: dest,
          chain: chainStr,
          download: conn.download || 0,
          upload: conn.upload || 0,
          isNew: true
        };

        packetLogs.unshift(entry);
        if (packetLogs.length > 300) {
          packetLogs.pop();
        }
      }
    } else {
      const existing = packetLogs.find(p => p.id === conn.id);
      if (existing) {
        existing.download = conn.download || 0;
        existing.upload = conn.upload || 0;
        existing.isNew = false;
      }
    }
  }

  // Update stats
  const totalEl = document.getElementById('total-packets-count');
  const procsEl = document.getElementById('active-processes-count');
  const downEl = document.getElementById('packets-download-total');
  const upEl = document.getElementById('packets-upload-total');

  if (totalEl) totalEl.textContent = packetLogs.length;
  if (procsEl) procsEl.textContent = knownProcesses.size;
  if (downEl) downEl.textContent = formatBytes(totalDown);
  if (upEl) upEl.textContent = formatBytes(totalUp);

  if (currentTab === 'packet-monitor') {
    renderPacketLogsTable();
  }
}

function updateProcessFilterDropdown() {
  const select = document.getElementById('packet-process-filter');
  if (!select) return;
  const curr = select.value;
  let html = `<option value="ALL">Все сервисы / сайты (${knownProcesses.size})</option>`;
  for (const proc of Array.from(knownProcesses).sort()) {
    html += `<option value="${proc}">${proc}</option>`;
  }
  select.innerHTML = html;
  select.value = curr;
}

function filterPacketLogs() {
  renderPacketLogsTable();
}

function togglePacketStream() {
  packetStreamActive = !packetStreamActive;
  const btn = document.getElementById('btn-toggle-packet-stream');
  const ind = document.getElementById('packet-live-indicator');
  if (btn) {
    btn.textContent = packetStreamActive ? '⏸️ Пауза' : '▶️ Запуск';
    btn.className = packetStreamActive ? 'btn btn-primary' : 'btn btn-success';
  }
  if (ind) {
    ind.className = packetStreamActive ? 'badge badge-success' : 'badge badge-warning';
    ind.innerHTML = packetStreamActive 
      ? '<span style="display:inline-block; width:6px; height:6px; background:#00E676; border-radius:50%; margin-right:6px; box-shadow: 0 0 8px #00E676;"></span>LIVE'
      : 'PAUSED';
  }
}

function clearPacketLogs() {
  packetLogs = [];
  seenPacketConnIds.clear();
  renderPacketLogsTable();
  const totalEl = document.getElementById('total-packets-count');
  if (totalEl) totalEl.textContent = '0';
}

function renderPacketLogsTable() {
  const tbody = document.getElementById('packet-logs-list');
  if (!tbody) return;

  const searchVal = (document.getElementById('packet-search-input')?.value || '').toLowerCase().trim();
  const procFilter = document.getElementById('packet-process-filter')?.value || 'ALL';
  const protoFilter = document.getElementById('packet-protocol-filter')?.value || 'ALL';

  const filtered = packetLogs.filter(item => {
    if (procFilter !== 'ALL' && item.process !== procFilter) return false;
    if (protoFilter !== 'ALL' && item.protocol !== protoFilter) return false;
    if (searchVal) {
      const matchSearch = item.process.toLowerCase().includes(searchVal) ||
                          item.destination.toLowerCase().includes(searchVal) ||
                          item.source.toLowerCase().includes(searchVal) ||
                          item.chain.toLowerCase().includes(searchVal);
      if (!matchSearch) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 40px; color: var(--text-muted);">
          ${packetLogs.length === 0 ? 'Ожидание сетевых пакетов...' : 'Пакеты по вашему фильтру не найдены'}
        </td>
      </tr>`;
    return;
  }

  let html = '';
  for (const item of filtered) {
    const col = getProcessColor(item.process);
    const protoClass = item.protocol === 'UDP' ? 'protocol-badge-udp' : 'protocol-badge-tcp';
    
    html += `
      <tr class="packet-row ${item.isNew ? 'new-entry' : ''}">
        <td style="color: var(--text-muted); font-family: monospace;">${item.time}</td>
        <td>
          <span class="process-badge" style="background: ${col.bg}; border: 1px solid ${col.border}; color: ${col.text};">
            <span class="proc-dot" style="background: ${col.border};"></span>
            ${item.process}
          </span>
        </td>
        <td><span class="protocol-badge ${protoClass}">${item.protocol}</span></td>
        <td style="font-family: monospace; color: var(--text-muted); font-size: 0.8rem;">${item.source}</td>
        <td style="font-family: monospace; font-weight: 600; color: var(--text-primary); word-break: break-all;">${item.destination}</td>
        <td>
          <span class="badge" style="background: rgba(255,255,255,0.06); border: 1px solid var(--border-color); color: var(--text-secondary); font-size: 0.78rem;">
            ${item.chain}
          </span>
        </td>
        <td style="text-align: right; font-family: var(--font-outfit); font-weight: 600;">
          <span style="color: var(--success); margin-right: 4px;">↓${formatBytes(item.download)}</span>
          <span style="color: var(--primary);">↑${formatBytes(item.upload)}</span>
        </td>
      </tr>`;
  }

  tbody.innerHTML = html;

  setupPacketTableScrollListener();

  const autoscroll = document.getElementById('packet-autoscroll')?.checked;
  if (autoscroll) {
    const wrapper = document.getElementById('packet-table-wrapper');
    if (wrapper) {
      isProgrammaticPacketScroll = true;
      wrapper.scrollTop = 0;
      setTimeout(() => { isProgrammaticPacketScroll = false; }, 60);
    }
  }
}

let isProgrammaticPacketScroll = false;

function setupPacketTableScrollListener() {
  const wrapper = document.getElementById('packet-table-wrapper');
  if (!wrapper || wrapper.dataset.scrollBound) return;
  wrapper.dataset.scrollBound = 'true';

  wrapper.addEventListener('scroll', () => {
    if (isProgrammaticPacketScroll) return;
    
    const checkbox = document.getElementById('packet-autoscroll');
    if (!checkbox) return;

    if (wrapper.scrollTop > 30) {
      if (checkbox.checked) {
        checkbox.checked = false;
      }
    } else if (wrapper.scrollTop <= 5) {
      if (!checkbox.checked) {
        checkbox.checked = true;
      }
    }
  });
}

window.filterPacketLogs = filterPacketLogs;
window.togglePacketStream = togglePacketStream;
window.clearPacketLogs = clearPacketLogs;

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

let directClientCachedDelay = 0;

function getLastDelay(proxy) {
  if (!proxy) return 0;
  const isDirectNode = proxy.name === 'DIRECT' || proxy.name === 'direct';
  if (Array.isArray(proxy.history) && proxy.history.length > 0) {
    const d = proxy.history[proxy.history.length - 1].delay || 0;
    if (d > 0) {
      if (isDirectNode) directClientCachedDelay = d;
      return d;
    }
  }
  if (proxy.extra && typeof proxy.extra === 'object') {
    for (const val of Object.values(proxy.extra)) {
      if (val && Array.isArray(val.history) && val.history.length > 0) {
        const d = val.history[val.history.length - 1].delay || 0;
        if (d > 0) {
          if (isDirectNode) directClientCachedDelay = d;
          return d;
        }
      }
    }
  }
  if (isDirectNode && directClientCachedDelay > 0) {
    return directClientCachedDelay;
  }
  return 0;
}

function resolveSelectedProxyDelay(proxyName, proxies) {
  const current = proxies[proxyName];
  if (!current) return 0;
  
  let active = current;
  let limit = 5;
  while (active && active.now && limit > 0) {
    const next = proxies[active.now];
    if (!next) break;
    active = next;
    limit--;
  }
  
  const activeDelay = getLastDelay(active);
  if (activeDelay > 0) return activeDelay;
  
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
      if (nodeName === 'DIRECT' || nodeName === 'direct') {
        directClientCachedDelay = data.delay;
      }
    } else {
      showToast(`❌ Пинг ${nodeName}: таймаут или недоступен`, 'error');
    }
    await loadProxiesDashboard();
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
    
    // Внедряем прокси из провайдеров в общий список proxiesData.proxies,
    // чтобы функции резолва задержек (resolveSelectedProxyDelay) и отрисовки
    // могли видеть задержки для каждого конкретного провайдер-узла.
    const proxiesMap = proxiesData.proxies || {};
    const providers = providersData.providers || {};
    for (const prov of Object.values(providers)) {
      if (prov.proxies && Array.isArray(prov.proxies)) {
        prov.proxies.forEach(p => {
          if (p.name && !proxiesMap[p.name]) {
            proxiesMap[p.name] = p;
          }
        });
      }
    }

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
  const excludeNames = ['GLOBAL', 'DIRECT', 'REJECT', '18+'];
  const groups = [];

  for (const [name, proxy] of Object.entries(proxies)) {
    if (excludeNames.includes(name)) continue;
    const pType = (proxy.type || '').toLowerCase();
    const isGroupType = ['selector', 'fallback', 'urltest', 'url-test', 'loadbalance', 'load-balance', 'relay'].includes(pType);
    if ((proxy.all && Array.isArray(proxy.all)) || isGroupType) {
      groups.push({ name, ...proxy });
    }
  }

  // Сортировка групп в нужном порядке:
  // 1 ряд: Auto-Best, Manual 1, Manual 2, Manual 3
  // 2 ряд: Подписки (StealthSurf, GitHub, Пробка 3 дня и др.)
  // 3 ряд: сервисы (Google, TikTok, YouTube и др.) по алфавиту
  const priorityOrder = [
    '🚀Auto-Best',
    '⚙️Manual 1',
    '⚙️Manual 2',
    '⚙️Manual 3',
    '⚡ goida-vpn-configs',
    '⚡ Пробка 3 дня',
    '💎 StealthSurf',
    '💎 StealthSurf 2',
    '🎱 GitHub'
  ];

  groups.sort((a, b) => {
    const idxA = priorityOrder.indexOf(a.name);
    const idxB = priorityOrder.indexOf(b.name);
    
    if (idxA !== -1 && idxB !== -1) {
      return idxA - idxB;
    }
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    
    // Подписки с иконками ⚡, 💎, 🎱 поднимаем выше сервисов
    const isSubA = a.name.startsWith('⚡') || a.name.startsWith('💎') || a.name.startsWith('🎱');
    const isSubB = b.name.startsWith('⚡') || b.name.startsWith('💎') || b.name.startsWith('🎱');

    if (isSubA && !isSubB) return -1;
    if (!isSubA && isSubB) return 1;

    return a.name.localeCompare(b.name);
  });

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
      if (np) {
        const isChild = np.all && Array.isArray(np.all);
        const d = isChild ? resolveSelectedProxyDelay(n, proxies) : getLastDelay(np);
        if (d > 0) aliveCount++;
      }
    });

    // Выделяем эмодзи из названия группы, если оно есть
    let extractedEmoji = '';
    let cleanGroupName = group.name;
    const emojiRegex = /^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]+)\s*/u;
    const emojiMatch = group.name.match(emojiRegex);
    if (emojiMatch) {
      extractedEmoji = emojiMatch[1];
      cleanGroupName = group.name.slice(emojiMatch[0].length).trim();
    }

    const typeIcons = { selector: '🔀', urltest: '⚡', 'url-test': '⚡', fallback: '🛡️', loadbalance: '⚖️', 'load-balance': '⚖️', relay: '🔗' };
    const typeLabels = { selector: 'Selector', urltest: 'URLTest', 'url-test': 'URLTest', fallback: 'Fallback', loadbalance: 'LoadBalance', 'load-balance': 'LoadBalance', relay: 'Relay' };
    const cardIcon = extractedEmoji || typeIcons[group.type.toLowerCase()] || '📡';
    const typeLabel = typeLabels[group.type.toLowerCase()] || group.type;

    let iconHtml = '';
    if (group.icon && (group.icon.startsWith('http') || group.icon.startsWith('./'))) {
      iconHtml = `<img src="${group.icon}" style="width: 18px; height: 18px; object-fit: contain; margin-right: 6px; flex-shrink: 0;" onerror="this.style.display='none'; this.nextElementSibling.style.display='inline-block';" />`;
    }

    const localVal = localStorage.getItem('pgc-collapsed-' + group.name);
    const isCollapsed = localVal !== null ? localVal === 'true' : true;
    if (isCollapsed) {
      card.classList.add('pgc-collapsed');
    }

    const nowName = group.now || '—';
    const nowProxy = proxies[nowName];
    const resolvedActiveDelay = resolveSelectedProxyDelay(group.name, proxies);
    const nowDelay = resolvedActiveDelay;
    const delayText = resolvedActiveDelay > 0 ? `${resolvedActiveDelay} ms` : '—';

    // --- Header ---
    const providerMapping = {
      '💎 StealthSurf': 'stealthsurf',
      '💎 StealthSurf 2': 'StealthSurf2',
      '🎱 GitHub': 'Igareck_Black_VPN'
    };
    
    let providerToUpdate = null;

    if (providerMapping[group.name]) {
      providerToUpdate = providerMapping[group.name];
    } else if (group.name.startsWith('⚡ ')) {
      const candidateName = group.name.substring(2).trim();
      if (proxyDashboardData && proxyDashboardData.providers) {
        const allProviders = proxyDashboardData.providers.providers || {};
        if (allProviders[candidateName]) {
          providerToUpdate = candidateName;
        }
      }
    }

    const header = document.createElement('div');
    header.className = 'pgc-header';
    header.innerHTML = `
      <div class="pgc-header-left">
        <span class="pgc-icon" style="display: flex; align-items: center;">${iconHtml}<span class="fallback-icon" style="${iconHtml ? 'display: none;' : 'display: inline-block;'}">${cardIcon}</span></span>
        <span class="pgc-name" title="${group.name}">${cleanGroupName || group.name}</span>
        <span class="pgc-meta">·&nbsp;${typeLabel}&nbsp;·&nbsp;${aliveCount}/${totalNodes}</span>
      </div>
      <div class="pgc-header-right">
        ${providerToUpdate ? `<button class="pgc-hc-btn" title="Обновить подписку" onclick="event.stopPropagation();updateProviderSub('${providerToUpdate}')">🔄</button>` : ''}
        ${providerToUpdate ? `<button class="pgc-hc-btn pgc-hc-bolt" title="Тест пинга подписки" onclick="event.stopPropagation();healthcheckProvider('${providerToUpdate}')">⚡</button>` : ''}
        <span class="pgc-count-badge" style="color: ${getLatencyColor(resolvedActiveDelay)}; background: ${getLatencyBgColor(resolvedActiveDelay)}">${delayText}</span>
        <span class="pgc-toggle-arrow ${isCollapsed ? '' : 'rotated'}">▸</span>
      </div>
    `;

    // Toggle collapse on left click
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      if (e.target.closest('.pgc-node-btn') || e.target.closest('.pgc-dot') || e.target.closest('button') || e.target.closest('a') || e.target.closest('input')) {
        return;
      }
      const nodesPanel = card.querySelector('.pgc-nodes-panel');
      const arrow = header.querySelector('.pgc-toggle-arrow');
      const isCurrentlyCollapsed = card.classList.contains('pgc-collapsed');
      
      if (nodesPanel && nodesPanel._onTransitionEnd) {
        nodesPanel.removeEventListener('transitionend', nodesPanel._onTransitionEnd);
        nodesPanel._onTransitionEnd = null;
      }
      
      if (isCurrentlyCollapsed) {
        card.classList.remove('pgc-collapsed');
        if (arrow) arrow.classList.add('rotated');
        if (totalNodes > 10) {
          const hb = card.querySelector('.pgc-health-bar-container');
          const dots = card.querySelector('.pgc-dots');
          if (hb) hb.classList.add('hidden-bar');
          if (dots) dots.classList.remove('hidden-dots');
        }

        if (nodesPanel) {
          const height = nodesPanel.scrollHeight;
          nodesPanel.style.maxHeight = height + 'px';
          nodesPanel.style.opacity = '1';
          nodesPanel._onTransitionEnd = (evt) => {
            if (evt.propertyName === 'max-height') {
              nodesPanel.style.maxHeight = 'none';
              nodesPanel.removeEventListener('transitionend', nodesPanel._onTransitionEnd);
              nodesPanel._onTransitionEnd = null;
            }
          };
          nodesPanel.addEventListener('transitionend', nodesPanel._onTransitionEnd);
        }
        localStorage.setItem('pgc-collapsed-' + group.name, 'false');
      } else {
        if (nodesPanel) {
          const height = nodesPanel.scrollHeight;
          nodesPanel.style.maxHeight = height + 'px';
          nodesPanel.offsetHeight; // force reflow
          nodesPanel.style.maxHeight = '0px';
          nodesPanel.style.opacity = '0';
        }
        if (arrow) arrow.classList.remove('rotated');
        if (totalNodes > 10) {
          const hb = card.querySelector('.pgc-health-bar-container');
          const dots = card.querySelector('.pgc-dots');
          if (hb) hb.classList.remove('hidden-bar');
          if (dots) dots.classList.add('hidden-dots');
        }

        card.classList.add('pgc-collapsed');
        localStorage.setItem('pgc-collapsed-' + group.name, 'true');
      }
    });

    // Ping selected proxy on right click
    card.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.pgc-node-btn') || e.target.closest('.pgc-dot') || e.target.closest('button') || e.target.closest('a') || e.target.closest('input')) {
        return;
      }
      e.preventDefault();
      const targetName = group.name || group.now || '—';
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
    `;

    // --- Latency dots row & Health distribution bar (>10 nodes) ---
    function createDotsRowElement() {
      const row = document.createElement('div');
      row.className = 'pgc-dots';
      group.all.forEach(nodeName => {
        const np = proxies[nodeName];
        const isChild = np && np.all && Array.isArray(np.all);
        const d = isChild ? resolveSelectedProxyDelay(nodeName, proxies) : getLastDelay(np);
        const dot = document.createElement('span');
        dot.className = 'pgc-dot ' + getLatencyDotClass(d);
        dot.title = nodeName + ': ' + (d > 0 ? d + 'ms' : 'N/A');
        if (nodeName === group.now) dot.classList.add('pgc-dot-active');
        dot.style.cursor = 'pointer';
        dot.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          pingProxyNode(nodeName);
        });
        if (isSelector) {
          dot.addEventListener('click', (e) => {
            e.stopPropagation();
            selectProxyInGroup(group.name, nodeName);
          });
        }
        row.appendChild(dot);
      });
      return row;
    }

    let dotsRowElement = null;
    let healthBarElement = null;

    if (totalNodes > 10) {
      let fastCount = 0;
      let mediumCount = 0;
      let slowCount = 0;
      let offlineCount = 0;

      group.all.forEach(nodeName => {
        const np = proxies[nodeName];
        const isChild = np && np.all && Array.isArray(np.all);
        const d = isChild ? resolveSelectedProxyDelay(nodeName, proxies) : getLastDelay(np);
        if (d > 0) {
          if (d < 200) fastCount++;
          else if (d < 500) mediumCount++;
          else slowCount++;
        } else {
          offlineCount++;
        }
      });

      healthBarElement = document.createElement('div');
      healthBarElement.className = 'pgc-health-bar-container' + (isCollapsed ? '' : ' hidden-bar');
      healthBarElement.title = `Быстрых: ${fastCount} | Средних: ${mediumCount} | Медленных: ${slowCount} | Недоступно: ${offlineCount} (Нажмите, чтобы развернуть)`;
      healthBarElement.innerHTML = `
        ${fastCount > 0 ? `<div class="pgc-hb-segment pgc-hb-fast" style="flex: ${fastCount};"></div>` : ''}
        ${mediumCount > 0 ? `<div class="pgc-hb-segment pgc-hb-medium" style="flex: ${mediumCount};"></div>` : ''}
        ${slowCount > 0 ? `<div class="pgc-hb-segment pgc-hb-slow" style="flex: ${slowCount};"></div>` : ''}
        ${offlineCount > 0 ? `<div class="pgc-hb-segment pgc-hb-offline" style="flex: ${offlineCount};"></div>` : ''}
      `;

      dotsRowElement = createDotsRowElement();
      if (isCollapsed) {
        dotsRowElement.classList.add('hidden-dots');
      }
    } else {
      dotsRowElement = createDotsRowElement();
    }

    // --- Node buttons panel (ONLY for <= 10 nodes) ---
    let nodesPanel = null;
    if (totalNodes <= 10) {
      nodesPanel = document.createElement('div');
      nodesPanel.className = 'pgc-nodes-panel';
      
      if (isCollapsed) {
        nodesPanel.style.maxHeight = '0px';
        nodesPanel.style.opacity = '0';
      } else {
        nodesPanel.style.maxHeight = 'none';
        nodesPanel.style.opacity = '1';
      }

      group.all.forEach(nodeName => {
        const np = proxies[nodeName];
        const isActive = nodeName === group.now;
        const isChildGroup = np && np.all && Array.isArray(np.all);
        const childType = np ? np.type : '';
        const resolvedChildDelay = isChildGroup ? resolveSelectedProxyDelay(nodeName, proxies) : 0;
        const d = isChildGroup ? resolvedChildDelay : getLastDelay(np);

        const btn = document.createElement('button');
        btn.className = 'pgc-node-btn' + (isActive ? ' active' : '');
        btn.setAttribute('data-tooltip', nodeName + ': ' + (d > 0 ? d + 'ms' : 'N/A'));

        btn.innerHTML = `
          <span class="pgc-nb-dot ${getLatencyDotClass(d)}"></span>
          <span class="pgc-nb-name">${nodeName}</span>
          ${isChildGroup ? '<span class="pgc-nb-type">' + childType + '</span>' : ''}
          ${(!isChildGroup && d > 0) ? '<span class="pgc-nb-delay" style="color:' + getLatencyColor(d) + '">' + d + 'ms</span>' : ''}
          ${isChildGroup ? `<span class="pgc-nb-count" style="color:${getLatencyColor(d)};background:${getLatencyBgColor(d)}">${d > 0 ? d + ' ms' : '—'}</span>` : ''}
        `;

        if (isSelector) {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectProxyInGroup(group.name, nodeName);
          });
        } else {
          btn.style.cursor = 'default';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
          });
        }
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          pingProxyNode(nodeName);
        });
        nodesPanel.appendChild(btn);
      });
    }

    const body = document.createElement('div');
    body.className = 'pgc-body';
    body.appendChild(selected);
    if (healthBarElement) body.appendChild(healthBarElement);
    if (dotsRowElement) body.appendChild(dotsRowElement);
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
        <button class="pgc-hc-btn pgc-hc-bolt" title="Тест пинга" onclick="event.stopPropagation();healthcheckProvider('${provider.name.replace(/'/g, "\\'")}')">⚡</button>
        <span class="pgc-toggle-arrow ${isCollapsed ? '' : 'rotated'}">▸</span>
      </div>
    `;

    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('a') || e.target.closest('input')) {
        return;
      }
      const nodesPanel = card.querySelector('.pgc-prov-nodes');
      const arrow = header.querySelector('.pgc-toggle-arrow');
      const isCurrentlyCollapsed = card.classList.contains('pgc-collapsed');
      
      if (nodesPanel && nodesPanel._onTransitionEnd) {
        nodesPanel.removeEventListener('transitionend', nodesPanel._onTransitionEnd);
        nodesPanel._onTransitionEnd = null;
      }
      
      if (isCurrentlyCollapsed) {
        card.classList.remove('pgc-collapsed');
        if (arrow) arrow.classList.add('rotated');
        if (nodesPanel) {
          const height = nodesPanel.scrollHeight;
          nodesPanel.style.maxHeight = height + 'px';
          nodesPanel.style.opacity = '1';
          nodesPanel._onTransitionEnd = (evt) => {
            if (evt.propertyName === 'max-height') {
              nodesPanel.style.maxHeight = 'none';
              nodesPanel.removeEventListener('transitionend', nodesPanel._onTransitionEnd);
              nodesPanel._onTransitionEnd = null;
            }
          };
          nodesPanel.addEventListener('transitionend', nodesPanel._onTransitionEnd);
        }
        localStorage.setItem('pgc-collapsed-' + provider.name, 'false');
      } else {
        if (nodesPanel) {
          const height = nodesPanel.scrollHeight;
          nodesPanel.style.maxHeight = height + 'px';
          nodesPanel.offsetHeight; // force reflow
          nodesPanel.style.maxHeight = '0px';
          nodesPanel.style.opacity = '0';
        }
        if (arrow) arrow.classList.remove('rotated');
        card.classList.add('pgc-collapsed');
        localStorage.setItem('pgc-collapsed-' + provider.name, 'true');
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
    if (isCollapsed) {
      nodesPanel.style.maxHeight = '0px';
      nodesPanel.style.opacity = '0';
    } else {
      nodesPanel.style.maxHeight = 'none';
      nodesPanel.style.opacity = '1';
    }

    nodesList.forEach(p => {
      const d = getLastDelay(p);
      const nodeDiv = document.createElement('div');
      nodeDiv.className = 'pgc-prov-node';
      nodeDiv.setAttribute('data-tooltip', p.name + ': ' + (d > 0 ? d + 'ms' : 'N/A') + ' (' + p.type + ')');
      nodeDiv.innerHTML = `
        <span class="pgc-nb-dot ${getLatencyDotClass(d)}"></span>
        <span class="pgc-nb-name">${p.name}</span>
        <span class="pgc-nb-type">${p.type}</span>
        ${d > 0 ? '<span class="pgc-nb-delay" style="color:' + getLatencyColor(d) + '">' + d + 'ms</span>' : '<span class="pgc-nb-delay" style="color:var(--text-muted)">—</span>'}
      `;
      nodesPanel.appendChild(nodeDiv);
    });

    const body = document.createElement('div');
    body.className = 'pgc-body';
    body.appendChild(info);
    body.appendChild(subDiv);
    body.appendChild(dotsRow);
    body.appendChild(nodesPanel);

    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);
  });
}

async function selectProxyInGroup(groupName, nodeName) {
  // 1. Мгновенное оптимистичное обновление элементов карточки в DOM (0ms UI latency)
  try {
    const cards = document.querySelectorAll('.pgc-card');
    cards.forEach(card => {
      if (card.dataset.groupName === groupName) {
        const selName = card.querySelector('.pgc-sel-name');
        if (selName) selName.textContent = nodeName;

        const btns = card.querySelectorAll('.pgc-node-btn');
        btns.forEach(btn => {
          const nameSpan = btn.querySelector('.pgc-nb-name');
          if (nameSpan && nameSpan.textContent === nodeName) {
            btn.classList.add('active');
          } else {
            btn.classList.remove('active');
          }
        });

        const dots = card.querySelectorAll('.pgc-dot');
        dots.forEach(dot => {
          if (dot.title && dot.title.startsWith(nodeName + ':')) {
            dot.classList.add('pgc-dot-active');
          } else {
            dot.classList.remove('pgc-dot-active');
          }
        });
      }
    });
  } catch (e) {}

  // 2. Отправка команды на сервер
  try {
    const res = await fetch('/api/xkeen/proxies/' + encodeURIComponent(groupName), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nodeName })
    });
    if (res.ok) {
      showToast('✅ ' + groupName + ' → ' + nodeName);
      loadProxiesDashboard().catch(() => {});
    } else {
      showToast('Ошибка переключения прокси', 'error');
    }
  } catch (err) {
    showToast('Ошибка сети: ' + err.message, 'error');
  }
}
async function healthcheckGroup(groupName) {
  try {
    showToast(`⚡ Измеряем пинг группы: ${groupName}...`);
    const res = await fetch(`/api/xkeen/proxies/${encodeURIComponent(groupName)}/delay?url=${encodeURIComponent('http://www.gstatic.com/generate_204')}&timeout=5000`);
    if (res.ok) {
      showToast(`✅ Пинг группы ${groupName} успешно проверен!`, 'success');
      await loadProxiesDashboard();
    } else {
      showToast(`❌ Ошибка проверки пинга группы ${groupName}`, 'error');
    }
  } catch (err) {
    showToast(`Ошибка сети при тесте пинга: ${err.message}`, 'error');
  }
}
window.healthcheckGroup = healthcheckGroup;

async function healthcheckProvider(providerName) {
  try {
    showToast('⚡ Измеряем пинг: ' + providerName + '...');
    const res = await fetch('/api/xkeen/providers/' + encodeURIComponent(providerName) + '/healthcheck');
    if (res.ok) {
      // Даем ядру Mihomo 1.5 секунды на выполнение параллельного пинга пула серверов
      await new Promise(r => setTimeout(r, 1500));
      const provRes = await fetch('/api/xkeen/providers');
      if (provRes.ok) {
        const provData = await provRes.json();
        const providers = provData.providers || {};
        const prov = providers[providerName];
        if (prov && Array.isArray(prov.proxies)) {
          let alive = 0;
          prov.proxies.forEach(p => {
            if (getLastDelay(p) > 0) alive++;
          });
          if (alive > 0) {
            showToast(`✅ Тест пинга ${providerName} завершён. Доступно: ${alive}/${prov.proxies.length}`, 'success');
          } else {
            showToast(`⚠️ Тест пинга ${providerName}: серверов в пуле ${prov.proxies.length}`, 'info');
          }
        } else {
          showToast('✅ Тест пинга ' + providerName + ' завершён', 'success');
        }
      } else {
        showToast('✅ Тест пинга ' + providerName + ' завершён', 'success');
      }
      setTimeout(() => loadProxiesDashboard(), 800);
    } else {
      let errMsg = '';
      try {
        const data = await res.json();
        errMsg = data.error || data.message || '';
      } catch (e) {}
      showToast(`Ошибка теста пинга: ${providerName}${errMsg ? ' (' + errMsg + ')' : ''}`, 'error');
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
    const staticTargets = ['DIRECT', '⚡ NFQWS 1 (ТВ)', '⚡ NFQWS 2 (Смартфон/ПК)'];
    staticTargets.forEach(targetName => {
      tasks.push(
        fetch('/api/proxies/ping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: targetName })
        }).then(r => r.json()).then(d => {
          if (d.success && d.delay > 0 && targetName === 'DIRECT') directClientCachedDelay = d.delay;
        }).catch(() => {})
      );
    });
    for (const [name, prov] of Object.entries(providers)) {
      if (prov.vehicleType !== 'Compatible' && name !== 'default') {
        tasks.push(
          fetch('/api/xkeen/providers/' + encodeURIComponent(name) + '/healthcheck')
            .catch(e => console.error('Ping fail:', name, e))
        );
      }
    }
    await Promise.all(tasks);
    
    // Ожидание завершения замеров всеми провайдерами
    await new Promise(r => setTimeout(r, 2000));
    
    const verifyRes = await fetch('/api/xkeen/providers');
    if (verifyRes.ok) {
      const verifyData = await verifyRes.json();
      const updatedProviders = verifyData.providers || {};
      let totalProxies = 0;
      let totalAlive = 0;
      for (const [name, prov] of Object.entries(updatedProviders)) {
        if (prov.vehicleType !== 'Compatible' && name !== 'default' && Array.isArray(prov.proxies)) {
          totalProxies += prov.proxies.length;
          prov.proxies.forEach(p => {
            if (getLastDelay(p) > 0) totalAlive++;
          });
        }
      }
      if (totalAlive > 0) {
        showToast(`✅ Тест пинга всех провайдеров завершён! Доступно: ${totalAlive}/${totalProxies}`, 'success');
      } else {
        showToast(`✅ Тест пинга всех провайдеров завершён!`, 'success');
      }
    } else {
      showToast('✅ Тест пинга всех провайдеров завершён!');
    }
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
        tooltip: {
          enabled: true,
          backgroundColor: 'rgba(15, 18, 25, 0.95)',
          bodyFont: { family: 'Inter', size: 13.5, weight: '500' },
          padding: 10,
          boxWidth: 10,
          boxHeight: 10,
          boxPadding: 6,
          cornerRadius: 6
        }
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
      
      // Update top bar live stats
      const topCpu = document.getElementById('top-bar-cpu');
      const topRam = document.getElementById('top-bar-ram');
      const topTemp = document.getElementById('top-bar-temp');
      if (topCpu) topCpu.textContent = stats.cpu + '%';
      if (topRam) topRam.innerHTML = `${stats.ramUsedPercent}%<span class="stat-detail"> (${stats.ramUsedMb}/${stats.ramTotalMb} МБ)</span>`;
      if (topTemp) topTemp.textContent = stats.temp + '°C';
      
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
  const card = document.querySelector('.system-monitor-card');
  const body = document.getElementById('system-monitor-body');
  const arrow = document.getElementById('system-monitor-arrow');
  
  if (!card || !body || !arrow) return;
  
  const isExpanded = localStorage.getItem('system-monitor-expanded') === 'true';
  if (isExpanded) {
    body.classList.add('expanded');
    arrow.classList.add('rotated');
    setTimeout(() => {
      body.style.maxHeight = body.scrollHeight + 'px';
      body.style.opacity = '1';
    }, 0);
    setTimeout(() => {
      if (!sysResourceChart) initSysResourceChart();
    }, 50);
  } else {
    body.classList.remove('expanded');
    body.style.maxHeight = '0px';
    body.style.opacity = '0';
    arrow.classList.remove('rotated');
  }
  
  const toggleMonitor = () => {
    const isCurrentlyExpanded = body.classList.contains('expanded');
    if (!isCurrentlyExpanded) {
      body.classList.add('expanded');
      arrow.classList.add('rotated');
      
      const height = body.scrollHeight;
      body.style.maxHeight = height + 'px';
      body.style.opacity = '1';
      
      localStorage.setItem('system-monitor-expanded', 'true');
      
      if (!sysResourceChart) {
        initSysResourceChart();
      } else {
        sysResourceChart.update('none');
      }
    } else {
      const height = body.scrollHeight;
      body.style.maxHeight = height + 'px';
      body.offsetHeight; // force reflow
      
      body.style.maxHeight = '0px';
      body.style.opacity = '0';
      arrow.classList.remove('rotated');
      body.classList.remove('expanded');
      
      localStorage.setItem('system-monitor-expanded', 'false');
    }
  };

  card.addEventListener('click', (e) => {
    toggleMonitor();
  });

  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    toggleMonitor();
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
  clientsInterval = setInterval(loadClients, silent ? 10000 : 1000);
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

  // Check if we can do an in-place update of existing elements to avoid closing dropdowns
  const existingRows = Array.from(tbody.querySelectorAll('tr[data-ip]'));
  const canUpdateInPlace = existingRows.length === filtered.length && 
    filtered.every((c, idx) => existingRows[idx] && existingRows[idx].getAttribute('data-ip') === c.ip);

  if (canUpdateInPlace) {
    filtered.forEach((c, idx) => {
      const tr = existingRows[idx];

      // 1. Device Info (Name)
      const nameSpan = tr.querySelector('.editable-name');
      if (nameSpan) {
        const expectedHtml = `${c.name || '<i>Устройство без имени</i>'} <svg width="12" height="12" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
        if (nameSpan.innerHTML !== expectedHtml) {
          nameSpan.innerHTML = expectedHtml;
        }
      }

      // 2. State Badge
      const badge = tr.querySelector('.status-badge');
      if (badge) {
        const expectedClass = `status-badge ${c.active ? 'active' : 'inactive'}`;
        const expectedText = c.active ? 'Активен' : 'Не в сети';
        if (badge.className !== expectedClass) badge.className = expectedClass;
        if (badge.textContent !== expectedText) badge.textContent = expectedText;
      }

      // 3. Current Speed
      const tdSpeed = tr.querySelector('.client-speed-text');
      if (tdSpeed) {
        let expectedSpeedHtml = '';
        if (c.active && (c.downSpeed > 0 || c.upSpeed > 0)) {
          expectedSpeedHtml = `<span style="color:#a8c7fa;">${formatSpeed(c.downSpeed)} ↓</span><br><span style="color:#3ddc84;">${formatSpeed(c.upSpeed)} ↑</span>`;
        } else {
          expectedSpeedHtml = '<span style="color:var(--text-muted);">0 KB/s</span>';
        }
        if (tdSpeed.innerHTML !== expectedSpeedHtml) {
          tdSpeed.innerHTML = expectedSpeedHtml;
        }
      }

      // 4. Cumulative Traffic Columns
      const trafficCells = tr.querySelectorAll('.client-traffic-text');
      const tdVpnTraffic = trafficCells[0];
      const tdDirectTraffic = trafficCells[1];

      if (tdVpnTraffic) {
        const vpnTotal = c.vpnDownload + c.vpnUpload;
        const vpnTotalAll = c.vpnDownloadTotal + c.vpnUploadTotal;
        let expectedVpnTraffic = '—';
        if (vpnTotalAll > 0) {
          expectedVpnTraffic = `
        <span title="Трафик за текущий месяц" style="font-weight: 500;">${formatBytes(vpnTotal)} <span style="font-size:0.7rem; opacity:0.6; font-weight:normal;">(мес)</span></span><br>
        <span title="Трафик за всё время" style="font-size:0.75rem; opacity:0.75;">${formatBytes(vpnTotalAll)} <span style="font-size:0.7rem; opacity:0.6;">(всего)</span></span><br>
        <span style="font-size:0.72rem; opacity:0.6;">↓ ${formatBytes(c.vpnDownload)} / ↑ ${formatBytes(c.vpnUpload)}</span>
      `;
        }
        if (tdVpnTraffic.innerHTML.replace(/\s+/g, ' ').trim() !== expectedVpnTraffic.replace(/\s+/g, ' ').trim()) {
          tdVpnTraffic.innerHTML = expectedVpnTraffic;
        }
      }

      if (tdDirectTraffic) {
        const directTotal = c.directDownload + c.directUpload;
        const directTotalAll = c.directDownloadTotal + c.directUploadTotal;
        let expectedDirectTraffic = '—';
        if (directTotalAll > 0) {
          expectedDirectTraffic = `
        <span title="Трафик за текущий месяц" style="font-weight: 500;">${formatBytes(directTotal)} <span style="font-size:0.7rem; opacity:0.6; font-weight:normal;">(мес)</span></span><br>
        <span title="Трафик за всё время" style="font-size:0.75rem; opacity:0.75;">${formatBytes(directTotalAll)} <span style="font-size:0.7rem; opacity:0.6;">(всего)</span></span><br>
        <span style="font-size:0.72rem; opacity:0.6;">↓ ${formatBytes(c.directDownload)} / ↑ ${formatBytes(c.directUpload)}</span>
      `;
        }
        if (tdDirectTraffic.innerHTML.replace(/\s+/g, ' ').trim() !== expectedDirectTraffic.replace(/\s+/g, ' ').trim()) {
          tdDirectTraffic.innerHTML = expectedDirectTraffic;
        }
      }

      // 5. VPN Toggle & Group dropdown select (Skip updating state if custom select dropdown is currently open)
      const wrapper = tr.querySelector('.custom-select-wrapper');
      const isDropdownOpen = wrapper && wrapper.classList.contains('open');

      if (!isDropdownOpen) {
        const realInput = tr.querySelector('input[type="checkbox"]');
        if (realInput && realInput.checked !== c.vpnEnabled && !realInput.disabled) {
          realInput.checked = c.vpnEnabled;
        }

        const select = tr.querySelector('.group-select');
        if (select) {
          const expectedDisabled = !c.vpnEnabled;
          if (select.disabled !== expectedDisabled) {
            select.disabled = expectedDisabled;
          }
          const currentGroup = c.group || '🚀Auto-Best';
          if (select.value !== currentGroup) {
            select.value = currentGroup;
          }
          if (typeof select.syncCustomSelect === 'function') {
            select.syncCustomSelect();
          }
        }
      }
    });
    return;
  }
  
  tbody.innerHTML = '';
  
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 30px;">Устройства не найдены</td></tr>';
    return;
  }
  
  filtered.forEach(c => {
    const tr = document.createElement('tr');
    tr.setAttribute('data-ip', c.ip);
    
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
    badge.textContent = c.active ? 'Активен' : 'Не в сети';
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
    const vpnTotalAll = c.vpnDownloadTotal + c.vpnUploadTotal;
    if (vpnTotalAll > 0) {
      tdVpnTraffic.innerHTML = `
        <span title="Трафик за текущий месяц" style="font-weight: 500;">${formatBytes(vpnTotal)} <span style="font-size:0.7rem; opacity:0.6; font-weight:normal;">(мес)</span></span><br>
        <span title="Трафик за всё время" style="font-size:0.75rem; opacity:0.75;">${formatBytes(vpnTotalAll)} <span style="font-size:0.7rem; opacity:0.6;">(всего)</span></span><br>
        <span style="font-size:0.72rem; opacity:0.6;">↓ ${formatBytes(c.vpnDownload)} / ↑ ${formatBytes(c.vpnUpload)}</span>
      `;
    } else {
      tdVpnTraffic.textContent = '—';
    }
    
    // DIRECT Cumulative traffic
    const tdDirectTraffic = document.createElement('td');
    tdDirectTraffic.className = 'client-traffic-text';
    const directTotal = c.directDownload + c.directUpload;
    const directTotalAll = c.directDownloadTotal + c.directUploadTotal;
    if (directTotalAll > 0) {
      tdDirectTraffic.innerHTML = `
        <span title="Трафик за текущий месяц" style="font-weight: 500;">${formatBytes(directTotal)} <span style="font-size:0.7rem; opacity:0.6; font-weight:normal;">(мес)</span></span><br>
        <span title="Трафик за всё время" style="font-size:0.75rem; opacity:0.75;">${formatBytes(directTotalAll)} <span style="font-size:0.7rem; opacity:0.6;">(всего)</span></span><br>
        <span style="font-size:0.72rem; opacity:0.6;">↓ ${formatBytes(c.directDownload)} / ↑ ${formatBytes(c.directUpload)}</span>
      `;
    } else {
      tdDirectTraffic.textContent = '—';
    }
    
    // VPN Toggle & Group dropdown select & Zapret selector
    const tdToggle = document.createElement('td');
    tdToggle.style.textAlign = 'center';
    
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';
    container.style.gap = '8px';
    container.style.flexWrap = 'wrap';
    
    const label = document.createElement('label');
    label.className = 'switch';
    label.title = 'Включить / выключить VPN для устройства';
    
    const realInput = document.createElement('input');
    realInput.type = 'checkbox';
    realInput.checked = c.vpnEnabled;
    
    const slider = document.createElement('span');
    slider.className = 'slider';
    
    label.appendChild(realInput);
    label.appendChild(slider);
    container.appendChild(label);
    
    // VPN Group Select
    const select = document.createElement('select');
    select.className = 'group-select';
    select.title = 'Основная группа VPN для устройства';
    select.style.background = 'var(--bg-card)';
    select.style.color = 'var(--text-primary)';
    select.style.border = '1px solid var(--border-color)';
    select.style.borderRadius = '6px';
    select.style.padding = '4px 8px';
    select.style.fontSize = '0.82rem';
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

    // Zapret Select
    const selectZapret = document.createElement('select');
    selectZapret.className = 'group-select zapret-select';
    selectZapret.title = 'Стратегия Запрета YouTube для устройства';
    selectZapret.style.background = 'rgba(245, 158, 11, 0.1)';
    selectZapret.style.color = '#f59e0b';
    selectZapret.style.border = '1px solid rgba(245, 158, 11, 0.3)';
    selectZapret.style.borderRadius = '6px';
    selectZapret.style.padding = '4px 8px';
    selectZapret.style.fontSize = '0.82rem';
    selectZapret.style.outline = 'none';
    selectZapret.style.cursor = 'pointer';

    const zapretOptions = [
      { value: 'default', text: '⚡ Запрет: Авто' },
      { value: 'nfqws1', text: '⚡ NFQWS 1 (ТВ)' },
      { value: 'nfqws2', text: '⚡ NFQWS 2 (Смартфон/ПК)' }
    ];

    const currentZapret = c.zapretMode || 'default';
    zapretOptions.forEach(opt => {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.text;
      if (opt.value === currentZapret) {
        el.selected = true;
      }
      selectZapret.appendChild(el);
    });
    
    realInput.onchange = async () => {
      select.disabled = !realInput.checked;
      await toggleClientVpn(c.ip, realInput);
    };
    
    select.onchange = async () => {
      await changeClientGroup(c.ip, select.value, select);
    };

    selectZapret.onchange = async () => {
      await changeClientZapret(c.ip, selectZapret.value, selectZapret);
    };
    
    container.appendChild(select);
    container.appendChild(selectZapret);
    tdToggle.appendChild(container);
    
    tr.appendChild(tdDevice);
    tr.appendChild(tdState);
    tr.appendChild(tdSpeed);
    tr.appendChild(tdVpnTraffic);
    tr.appendChild(tdDirectTraffic);
    tr.appendChild(tdToggle);
    
    tbody.appendChild(tr);
  });
  if (typeof initCustomSelects === 'function') {
    initCustomSelects();
  }
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.message || data.error || 'HTTP ' + res.status);
    
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.message || data.error || 'HTTP ' + res.status);
    
    showToast(`Устройство ${ip} направлено в группу ${group}`);
    loadClients();
  } catch (err) {
    showToast(`Ошибка смены группы: ${err.message}`, 'error');
    loadClients();
  } finally {
    selectEl.disabled = false;
  }
}

async function changeClientZapret(ip, mode, selectEl) {
  selectEl.disabled = true;
  try {
    const res = await fetch('/api/clients/zapret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, mode })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.message || data.error || 'HTTP ' + res.status);
    
    const modeLabel = mode === 'nfqws1' ? '⚡ NFQWS 1 (ТВ)' : (mode === 'nfqws2' ? '⚡ NFQWS 2 (Смартфон/ПК)' : '⚡ По умолчанию');
    showToast(`Для устройства ${ip} установлен Запрет: ${modeLabel}`);
    loadClients();
  } catch (err) {
    showToast(`Ошибка смены стратегии Запрета: ${err.message}`, 'error');
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

document.addEventListener('DOMContentLoaded', () => {
  startSystemStatsPolling();
});

const clientsSearchBox = document.getElementById('clients-search-box');
if (clientsSearchBox) {
  clientsSearchBox.oninput = () => renderClientsTable();
}

