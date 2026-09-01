let leakedDomains = [];
let proxyGroups = [];
let subGroups = [];
let proxiesList = [];
let torData = null;
let configEditor = null; // Инстанс CodeMirror
let currentConfigFileId = 'config';
let configFiles = [];

// Отключение залипающих нативных браузерных подсказок (title) на мобильных экранах
if (typeof window !== 'undefined') {
  document.addEventListener('touchstart', function(e) {
    const el = e.target.closest('[title]');
    if (el) {
      const title = el.getAttribute('title');
      if (title) {
        el.setAttribute('data-original-title', title);
        el.removeAttribute('title');
      }
    }
  }, { passive: true, capture: true });
}

// Показ уведомлений
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-hide');
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 450);
  }, 3500);
}

// Загрузка и переключение глобального режима ядра Mihomo
async function loadGlobalMihomoMode() {
  try {
    const res = await fetch('/api/mihomo/mode');
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.mode) {
        updateModeUI(data.mode);
      }
    }
  } catch (e) {}
}

async function setGlobalMihomoMode(newMode) {
  try {
    let msg = 'Переключение режима...';
    if (newMode === 'direct') msg = 'Переключение в Direct (Выкл)...';
    else if (newMode === 'zapret') msg = 'Переключение в режим Запрета (Без VPN)...';
    else if (newMode === 'rule') msg = 'Переключение в режим VPN (Маршруты)...';
    
    showToast(msg, 'info');
    const res = await fetch('/api/mihomo/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: newMode })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        updateModeUI(newMode);
        if (newMode === 'direct') {
          showToast('🔌 Режим Direct включен: весь трафик идёт напрямую!', 'warning');
        } else if (newMode === 'zapret') {
          showToast('⚡ Режим Только Запрет включен: VPN отключен, YouTube идёт через Запрет!', 'warning');
        } else {
          showToast('🛡️ Глобальный режим VPN включен: маршрутизация трафика возобновлена!', 'success');
        }
      }
    }
  } catch (e) {
    showToast('Ошибка смены режима: ' + e.message, 'error');
  }
}

function updateModeUI(mode) {
  const btnRule = document.getElementById('mode-btn-rule');
  const btnZapret = document.getElementById('mode-btn-zapret');
  const btnDirect = document.getElementById('mode-btn-direct');
  if (btnRule) btnRule.classList.toggle('active', mode === 'rule');
  if (btnZapret) btnZapret.classList.toggle('active', mode === 'zapret');
  if (btnDirect) btnDirect.classList.toggle('active', mode === 'direct');
}

document.addEventListener('DOMContentLoaded', () => {
  loadGlobalMihomoMode();
});

// Переключение вкладок
function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  
  const tabEl = document.getElementById('tab-content-' + tabId);
  const btnEl = document.getElementById('tab-btn-' + tabId);
  if (tabEl) tabEl.classList.add('active');
  if (btnEl) btnEl.classList.add('active');
  
  const tabTitles = {
    'proxies-dashboard': '⚡ Прокси-панель и группы',
    'subs': '🌐 Подписки прокси-провайдеров',
    'import': '🔌 Импорт внешних ссылок',
    'clients': '💻 Управление устройствами сети',
    'traffic': '📊 График трафика real-time',
    'connections': '🔌 Активные соединения',
    'packet-monitor': '📦 Мониторинг сетевых пакетов',
    'logs': '📋 Системные логи ядра',
    'trace': '🛰️ Трассировка маршрутов',
    'dpi': '⚡ Тюнер DPI и авто-ротация',
    'rules': '🛠️ Быстрые пользовательские правила',
    'editor': '📝 Редактор YAML конфигураций',
    'dns': '🛡️ Настройка DNS и Резолвера',
    'qr': '📱 QR-подключения клиентов',
    'leak': '🔍 Анализ утечек доменов'
  };

  const titleEl = document.getElementById('current-tab-title');
  if (titleEl && tabTitles[tabId]) {
    titleEl.textContent = tabTitles[tabId];
  }
  
  if (tabId === 'editor') {
    loadConfigFilesList();
    loadConfigEditor();
    setTimeout(() => {
      if (configEditor) configEditor.refresh();
    }, 50);
  } else if (tabId === 'dns') {
    loadDnsSettings();
  } else if (tabId === 'import') {
    loadImportGroups();
  } else if (tabId === 'subs') {
    loadSubscriptions();
  } else if (tabId === 'ping') {
    loadProxiesList();
  } else if (tabId === 'dpi') {
    loadDpiStatus();
  } else if (tabId === 'rules') {
    loadDynamicRulesTab();
  } else if (tabId === 'updates') {
    loadVersionsList();
  } else if (tabId === 'qr') {
    loadQrConnections();
  } else if (tabId === 'connections') {
    if (typeof startConnectionsPolling === 'function') startConnectionsPolling(false);
    if (typeof loadConnections === 'function') loadConnections();
  } else if (tabId === 'traffic') {
    if (typeof initAllTrafficCharts === 'function') initAllTrafficCharts();
    if (typeof updateAllTrafficCharts === 'function') updateAllTrafficCharts();
  } else if (tabId === 'packet-monitor') {
    if (typeof startConnectionsPolling === 'function') startConnectionsPolling(false);
  } else if (tabId === 'logs') {
    if (typeof reRenderLogs === 'function') reRenderLogs();
  } else if (tabId === 'clients') {
    if (typeof startClientsPolling === 'function') startClientsPolling(false);
    if (typeof loadClientsData === 'function') loadClientsData();
  } else if (tabId === 'leak') {
    loadData();
  } else {
    loadData();
  }
}

// Загрузка данных бэкенда (Утекшие домены)
async function loadData() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error('Ошибка сети');
    const payload = await res.json();
    
    leakedDomains = payload.domains || [];
    proxyGroups = payload.groups || [];

    renderTable();
  } catch (err) {
    showToast('Не удалось загрузить данные с роутера: ' + err.message, 'error');
  }
}

// Отрисовка таблицы утекших доменов
function renderTable() {
  const tbody = document.getElementById('domains-list');
  const countSpan = document.getElementById('domain-count');
  const searchVal = document.getElementById('search-box').value.toLowerCase();
  
  const filtered = leakedDomains.filter(d => d.domain.toLowerCase().includes(searchVal));
  countSpan.textContent = `Всего: ${filtered.length}`;
  
  if (filtered.length === 0) {
    tbody.parentElement.style.display = 'none';
    document.getElementById('empty-state').style.display = 'block';
    return;
  }

  tbody.parentElement.style.display = 'table';
  document.getElementById('empty-state').style.display = 'none';
  tbody.innerHTML = '';

  filtered.forEach((d, idx) => {
    const tr = document.createElement('tr');
    
    // Чекбокс
    const tdCheck = document.createElement('td');
    tdCheck.className = 'checkbox-cell';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'row-select';
    chk.dataset.domain = d.domain;
    chk.onchange = updateApplyButtonState;
    tdCheck.appendChild(chk);

    // Домен
    const tdDomain = document.createElement('td');
    tdDomain.className = 'domain-name';
    tdDomain.textContent = d.domain;

    // Таймстамп
    const tdTime = document.createElement('td');
    tdTime.className = 'timestamp';
    tdTime.textContent = d.timestamp;

    // Маршрут
    const tdRoute = document.createElement('td');
    const spanRoute = document.createElement('span');
    spanRoute.className = 'route-badge';
    spanRoute.textContent = d.chain;
    tdRoute.appendChild(spanRoute);

    // Дропдаун группы
    const tdSelect = document.createElement('td');
    const sel = document.createElement('select');
    sel.className = 'row-group-select';
    sel.dataset.domain = d.domain;

    // Генерируем опции для дропдауна
    proxyGroups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      if (g === 'DIRECT') opt.selected = true; // DIRECT по умолчанию
      sel.appendChild(opt);
    });
    tdSelect.appendChild(sel);

    tr.appendChild(tdCheck);
    tr.appendChild(tdDomain);
    tr.appendChild(tdTime);
    tr.appendChild(tdRoute);
    tr.appendChild(tdSelect);

    tbody.appendChild(tr);
  });

  updateApplyButtonState();
  initCustomSelects();
}

// Кнопка применить (активация)
function updateApplyButtonState() {
  const checked = document.querySelectorAll('.row-select:checked');
  document.getElementById('btn-apply').disabled = checked.length === 0;
}

// Выбрать все
document.getElementById('header-select-all').onchange = function(e) {
  const chks = document.querySelectorAll('.row-select');
  chks.forEach(c => c.checked = e.target.checked);
  updateApplyButtonState();
};

// Выбрать все в DIRECT
document.getElementById('btn-select-all-direct').onclick = function() {
  const chks = document.querySelectorAll('.row-select');
  chks.forEach(c => c.checked = true);
  const selects = document.querySelectorAll('.row-group-select');
  selects.forEach(s => s.value = 'DIRECT');
  document.getElementById('header-select-all').checked = true;
  updateApplyButtonState();
};

// Поиск
document.getElementById('search-box').oninput = renderTable;

// Кнопка применения утекших доменов
document.getElementById('btn-apply').onclick = async function() {
  const btn = this;
  const checked = document.querySelectorAll('.row-select:checked');
  const assignments = [];

  checked.forEach(chk => {
    const domain = chk.dataset.domain;
    const sel = document.querySelector(`select.row-group-select[data-domain="${domain}"]`);
    assignments.push({ domain, group: sel.value });
  });

  btn.disabled = true;
  btn.textContent = 'Применяем...';

  try {
    const res = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments })
    });

    const result = await res.json();
    if (!res.ok || !result.success) {
      throw new Error(result.message || 'Ошибка сервера');
    }

    showToast('Правила добавлены, Mihomo успешно перезапущен!');
    document.getElementById('header-select-all').checked = false;
    loadData();
  } catch (err) {
    showToast('Ошибка при сохранении: ' + err.message, 'error');
  } finally {
    btn.textContent = 'Применить выбранные';
    updateApplyButtonState();
  }
};

// === ФУНКЦИОНАЛ РЕДАКТОРА YAML ===
async function loadConfigFilesList() {
  const container = document.getElementById('config-files-container');
  if (!container) return;
  
  try {
    const res = await fetch('/api/config/files');
    if (!res.ok) throw new Error('Не удалось получить список файлов');
    const data = await res.json();
    if (data.success && Array.isArray(data.files)) {
      configFiles = data.files;
      renderConfigFileChips();
    }
  } catch (err) {
    console.error('Ошибка загрузки списка файлов конфигурации:', err.message);
  }
}

function renderConfigFileChips() {
  const container = document.getElementById('config-files-container');
  if (!container) return;
  
  container.innerHTML = '';
  configFiles.forEach(file => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    if (file.id === currentConfigFileId) {
      chip.classList.add('active');
    }
    chip.textContent = file.name;
    chip.title = file.path; // Всплывающая подсказка с полным путем
    chip.onclick = () => {
      if (file.id === currentConfigFileId) return;
      currentConfigFileId = file.id;
      document.querySelectorAll('.file-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      loadConfigEditor();
    };
    container.appendChild(chip);
  });
}

async function loadConfigEditor() {
  if (!configEditor) return;
  
  const saveBtn = document.getElementById('btn-save-config');
  configEditor.setOption('readOnly', false);
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.title = '';
  }

  configEditor.setValue('Загрузка конфигурации с роутера...');
  try {
    const res = await fetch('/api/config?file=' + encodeURIComponent(currentConfigFileId));
    if (!res.ok) throw new Error('Не удалось прочитать конфигурацию');
    const text = await res.text();
    configEditor.setValue(text);
  } catch (err) {
    showToast('Ошибка загрузки конфигурации: ' + err.message, 'error');
    configEditor.setValue('Ошибка при загрузке. Нажмите кнопку "Обновить".');
  }
}

document.getElementById('btn-reload-config-editor').onclick = async function() {
  await loadConfigFilesList();
  await loadConfigEditor();
};

document.getElementById('btn-download-config').onclick = function() {
  if (!configEditor) return;
  const configText = configEditor.getValue();
  const blob = new Blob([configText], { type: 'text/yaml;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  
  const fileObj = configFiles.find(f => f.id === currentConfigFileId);
  const filename = fileObj ? fileObj.name.replace(/\//g, '_') + '.yaml' : 'config.yaml';
  
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('Файл подготовлен к скачиванию');
};

document.getElementById('btn-save-config').onclick = async function() {
  if (!configEditor) return;
  const btn = this;
  const newConfig = configEditor.getValue();
  
  if (!newConfig.trim()) {
    showToast('Конфигурация не может быть пустой!', 'error');
    return;
  }
  
  if (!confirm('Вы уверены, что хотите сохранить этот файл и обновить конфигурацию Mihomo?')) {
    return;
  }
  
  btn.disabled = true;
  btn.textContent = 'Применяем...';
  
  try {
    const res = await fetch('/api/config?file=' + encodeURIComponent(currentConfigFileId), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: newConfig
    });
    const result = await res.json();
    if (!res.ok || !result.success) {
      throw new Error(result.message || 'Ошибка сервера');
    }
    showToast('Конфигурация успешно сохранена и применена!');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Сохранить и применить';
  }
};

// === ФУНКЦИОНАЛ ИМПОРТА ССЫЛОК ===
async function loadImportGroups() {
  const container = document.getElementById('import-groups-checkboxes');
  container.innerHTML = 'Загрузка групп...';
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error('Ошибка сети');
    const payload = await res.json();
    const groups = payload.groups || [];
    
    container.innerHTML = '';
    groups.forEach(g => {
      if (g === 'REJECT' || g === 'DIRECT') return;
      
      const label = document.createElement('label');
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.gap = '8px';
      label.style.cursor = 'pointer';
      label.style.color = '#ffffff';
      
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.value = g;
      chk.className = 'import-group-select';
      if (g === 'GLOBAL' || g === '🚀Auto-Best') chk.checked = true;
      
      label.appendChild(chk);
      label.appendChild(document.createTextNode(g));
      container.appendChild(label);
    });
  } catch (err) {
    container.innerHTML = 'Ошибка загрузки групп: ' + err.message;
  }
}

document.getElementById('btn-import-links').onclick = async function() {
  const btn = this;
  const textarea = document.getElementById('import-links-textarea');
  const linksText = textarea.value;
  const links = linksText.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && (l.startsWith('vless://') || l.startsWith('ss://') || l.startsWith('trojan://')));
  
  if (links.length === 0) {
    showToast('Не найдено корректных ссылок для импорта (vless://, ss://, trojan://)', 'error');
    return;
  }
  
  const checkedGroups = [];
  document.querySelectorAll('.import-group-select:checked').forEach(chk => {
    checkedGroups.push(chk.value);
  });
  
  btn.disabled = true;
  btn.textContent = 'Импортируем...';
  
  try {
    const res = await fetch('/api/import-proxies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links, groups: checkedGroups })
    });
    const result = await res.json();
    if (!res.ok || !result.success) {
      throw new Error(result.message || 'Ошибка импорта');
    }
    showToast(`Успешно импортировано прокси: ${result.count}!`);
    textarea.value = '';
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📥 Импортировать прокси';
  }
};

// === ФУНКЦИОНАЛ МЕНЕДЖЕРА ПОДПИСОК ===
async function moveSubPriority(list, index, direction) {
  const names = list.map(s => s.name);
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= names.length) return;
  
  const temp = names[index];
  names[index] = names[targetIndex];
  names[targetIndex] = temp;
  
  try {
    showToast('⏳ Сохранение нового приоритета подписок...');
    const res = await fetch('/api/providers/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: names })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.message || 'Ошибка изменения порядка');
    showToast('✅ Приоритет подписок сохранён!');
    loadSubscriptions();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function loadSubscriptions() {
  const tbody = document.getElementById('subs-list');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Загрузка списка подписок...</td></tr>';
  
  try {
    const res = await fetch('/api/providers');
    if (!res.ok) throw new Error('Ошибка загрузки провайдеров');
    const payload = await res.json();
    const list = payload.list || [];
    subGroups = payload.groups || [];
    
    tbody.innerHTML = '';
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);">Нет настроенных подписок</td></tr>';
      return;
    }
    
    list.forEach((sub, idx) => {
      const tr = document.createElement('tr');

      // Кнопки приоритета (вверх / вниз)
      const tdPriority = document.createElement('td');
      tdPriority.style.whiteSpace = 'nowrap';
      tdPriority.style.width = '70px';
      tdPriority.style.textAlign = 'center';

      const btnUp = document.createElement('button');
      btnUp.className = 'btn';
      btnUp.style.padding = '3px 6px';
      btnUp.style.fontSize = '0.8rem';
      btnUp.style.marginRight = '3px';
      btnUp.textContent = '⬆️';
      btnUp.disabled = idx === 0;
      btnUp.title = 'Повысить приоритет подписки';
      btnUp.onclick = () => moveSubPriority(list, idx, -1);

      const btnDown = document.createElement('button');
      btnDown.className = 'btn';
      btnDown.style.padding = '3px 6px';
      btnDown.style.fontSize = '0.8rem';
      btnDown.textContent = '⬇️';
      btnDown.disabled = idx === list.length - 1;
      btnDown.title = 'Понизить приоритет подписки';
      btnDown.onclick = () => moveSubPriority(list, idx, 1);

      tdPriority.appendChild(btnUp);
      tdPriority.appendChild(btnDown);
      
      const tdName = document.createElement('td');
      tdName.style.fontWeight = '600';
      tdName.innerHTML = `<div>${sub.name}</div>${sub.deviceName ? `<div style="font-size: 0.76rem; color: #60a5fa; font-weight: normal; margin-top: 2px;">🏷️ ${sub.deviceName}</div>` : ''}`;
      
      const tdUrl = document.createElement('td');
      tdUrl.style.wordBreak = 'break-all';
      tdUrl.style.maxWidth = '250px';
      tdUrl.style.fontSize = '0.9rem';
      tdUrl.textContent = sub.url;
      
      const tdInterval = document.createElement('td');
      tdInterval.textContent = sub.interval;
      
      const tdCount = document.createElement('td');
      tdCount.style.fontFamily = 'monospace';
      tdCount.textContent = sub.count !== undefined ? sub.count : '-';
      
      const tdUpdated = document.createElement('td');
      tdUpdated.className = 'timestamp';
      if (sub.updatedAt) {
        const d = new Date(sub.updatedAt);
        tdUpdated.textContent = d.toLocaleString('ru-RU');
      } else {
        tdUpdated.textContent = 'Не обновлялось';
      }
      
      const tdActions = document.createElement('td');
      tdActions.style.textAlign = 'center';
      tdActions.style.whiteSpace = 'nowrap';
      
      // Кнопка обновления
      const btnUpdate = document.createElement('button');
      btnUpdate.className = 'btn';
      btnUpdate.style.padding = '6px 12px';
      btnUpdate.style.marginRight = '6px';
      btnUpdate.textContent = '🔄 Обновить';
      btnUpdate.onclick = async function() {
        btnUpdate.disabled = true;
        btnUpdate.textContent = '...';
        try {
          const resUpdate = await fetch('/api/providers/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: sub.name })
          });
          const text = await resUpdate.text();
          let r = {};
          try {
            r = JSON.parse(text);
          } catch(e) {
            throw new Error(text.includes('<html') ? 'Сервер перезагружается, повторите через пару секунд' : (text.substring(0, 100) || ('HTTP ' + resUpdate.status)));
          }
          if (!resUpdate.ok || !r.success) throw new Error(r.message || 'Ошибка сети');
          showToast(`Подписка ${sub.name} успешно обновлена!`, 'success');
          await loadSubscriptions();
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          btnUpdate.disabled = false;
          btnUpdate.textContent = '🔄 Обновить';
        }
      };
      
function copyToClipboardFallback(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      if (successful) resolve();
      else reject(new Error('execCommand failed'));
    } catch (err) {
      document.body.removeChild(textArea);
      reject(err);
    }
  });
}

      // Кнопка копирования готовой подписки (Clash / V2Ray)
      const btnCopy = document.createElement('button');
      btnCopy.className = 'btn';
      btnCopy.style.padding = '6px 12px';
      btnCopy.style.marginRight = '6px';
      btnCopy.style.background = 'rgba(168, 85, 247, 0.1)';
      btnCopy.style.borderColor = 'rgba(168, 85, 247, 0.2)';
      btnCopy.style.color = '#c084fc';
      btnCopy.textContent = '📋 Ссылка';
      btnCopy.title = 'Скопировать ссылку на эту подписку для других устройств (ПК / Телефон)';
      btnCopy.onclick = function() {
        const host = window.location.host;
        const proto = window.location.protocol;
        const clashUrl = `${proto}//${host}/sub/${encodeURIComponent(sub.name)}.yaml`;
        copyToClipboardFallback(clashUrl).then(() => {
          showToast(`✅ Ссылка на подписку скопирована в буфер: ${clashUrl}`, 'success');
        }).catch(() => {
          prompt('Скопируйте ссылку для Clash/Mihomo:', clashUrl);
        });
      };

      // Кнопка редактирования
      const btnEdit = document.createElement('button');
      btnEdit.className = 'btn';
      btnEdit.style.padding = '6px 12px';
      btnEdit.style.marginRight = '6px';
      btnEdit.style.background = 'rgba(59, 130, 246, 0.1)';
      btnEdit.style.borderColor = 'rgba(59, 130, 246, 0.2)';
      btnEdit.style.color = '#60a5fa';
      btnEdit.textContent = '✏️ Правка';
      btnEdit.onclick = function() {
        showAddSubModal(sub);
      };
      
      // Кнопка удаления
      const btnDel = document.createElement('button');
      btnDel.className = 'btn';
      btnDel.style.padding = '6px 12px';
      btnDel.style.background = 'rgba(239, 68, 68, 0.1)';
      btnDel.style.borderColor = 'rgba(239, 68, 68, 0.2)';
      btnDel.style.color = 'var(--danger)';
      btnDel.textContent = '❌ Удалить';
      btnDel.onclick = async function() {
        if (!confirm(`Вы действительно хотите удалить подписку ${sub.name}? Все её прокси-узлы будут удалены.`)) return;
        btnDel.disabled = true;
        btnDel.textContent = '...';
        try {
          const resDel = await fetch('/api/providers/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: sub.name })
          });
          const r = await resDel.json();
          if (!resDel.ok || !r.success) throw new Error(r.message || 'Ошибка сети');
          showToast(`Подписка ${sub.name} успешно удалена!`);
          loadSubscriptions();
        } catch (err) {
          showToast(err.message, 'error');
          btnDel.disabled = false;
          btnDel.textContent = '❌ Удалить';
        }
      };
      
      tdActions.appendChild(btnUpdate);
      tdActions.appendChild(btnCopy);
      tdActions.appendChild(btnEdit);
      tdActions.appendChild(btnDel);
      
      tr.appendChild(tdPriority);
      tr.appendChild(tdName);
      tr.appendChild(tdUrl);
      tr.appendChild(tdInterval);
      tr.appendChild(tdCount);
      tr.appendChild(tdUpdated);
      tr.appendChild(tdActions);
      
      tbody.appendChild(tr);
    });
  } catch (err) {
    showToast(err.message, 'error');
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--danger);">Ошибка: ${err.message}</td></tr>`;
  }
}

function showAddSubModal(sub = null) {
  const modal = document.getElementById('add-sub-modal');
  const title = document.getElementById('sub-modal-title');
  const nameInput = document.getElementById('sub-name');
  const urlInput = document.getElementById('sub-url');
  const deviceNameInput = document.getElementById('sub-device-name');
  const intervalInput = document.getElementById('sub-interval');
  const oldNameInput = document.getElementById('edit-sub-old-name');
  const groupsSection = document.getElementById('sub-groups-section');
  
  modal.style.display = 'block';
  
  const container = document.getElementById('sub-groups-checkboxes');
  container.innerHTML = '';
  subGroups.forEach(g => {
    if (g === 'REJECT' || g === 'DIRECT') return;
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '8px';
    label.style.cursor = 'pointer';
    label.style.color = '#ffffff';
    
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.value = g;
    chk.className = 'sub-group-select';
    if (g === '⚙️Manual 1' || g === '⚙️Manual 2' || g === '⚙️Manual 3') chk.checked = true;
    
    label.appendChild(chk);
    label.appendChild(document.createTextNode(g));
    container.appendChild(label);
  });

  if (sub) {
    title.textContent = 'Редактировать подписку: ' + sub.name;
    nameInput.value = sub.name;
    nameInput.disabled = true;
    urlInput.value = sub.url;
    if (deviceNameInput) deviceNameInput.value = sub.deviceName || '';
    intervalInput.value = sub.interval;
    oldNameInput.value = sub.name;
    groupsSection.style.display = 'none';
  } else {
    title.textContent = 'Добавить новую подписку';
    nameInput.value = '';
    nameInput.disabled = false;
    urlInput.value = '';
    if (deviceNameInput) deviceNameInput.value = '';
    intervalInput.value = '3600';
    oldNameInput.value = '';
    groupsSection.style.display = 'block';
  }
}

function hideAddSubModal() {
  document.getElementById('add-sub-modal').style.display = 'none';
}

async function saveSubscription() {
  const name = document.getElementById('sub-name').value.trim();
  const url = document.getElementById('sub-url').value.trim();
  const deviceName = document.getElementById('sub-device-name') ? document.getElementById('sub-device-name').value.trim() : '';
  const rawInterval = document.getElementById('sub-interval').value.trim();
  const interval = rawInterval ? (parseInt(rawInterval, 10) || 3600) : 3600;
  const oldName = document.getElementById('edit-sub-old-name').value;
  const btn = document.getElementById('btn-save-sub');
  
  if (!name || !url) {
    showToast('Пожалуйста, укажите название и ссылку на подписку!', 'error');
    return;
  }
  
  btn.disabled = true;
  btn.textContent = 'Сохранение...';
  
  const isEdit = oldName.length > 0;
  const apiEndpoint = isEdit ? '/api/providers/edit' : '/api/providers/add';
  
  const payload = { name, url, interval, deviceName };
  if (!isEdit) {
    const checkedGroups = [];
    document.querySelectorAll('.sub-group-select:checked').forEach(chk => {
      checkedGroups.push(chk.value);
    });
    payload.groups = checkedGroups;
  }
  
  try {
    const res = await fetch(apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (!res.ok || !result.success) throw new Error(result.message || 'Ошибка сохранения');
    
    showToast(isEdit ? 'Подписка успешно изменена!' : 'Подписка успешно добавлена!');
    hideAddSubModal();
    loadSubscriptions();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сохранить';
  }
}

// === ФУНКЦИОНАЛ ПИНГ-ТЕСТА ===
async function loadProxiesList() {
  const tbody = document.getElementById('ping-list');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Загрузка списка прокси...</td></tr>';
  
  try {
    const res = await fetch('/api/proxies');
    if (!res.ok) throw new Error('Ошибка загрузки списка прокси');
    const payload = await res.json();
    proxiesList = payload.list || [];
    renderProxiesList();
  } catch (err) {
    showToast(err.message, 'error');
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--danger);">Ошибка: ${err.message}</td></tr>`;
  }
}

function renderProxiesList() {
  const tbody = document.getElementById('ping-list');
  const searchVal = document.getElementById('ping-search-box').value.toLowerCase();
  
  const filtered = proxiesList.filter(p => p.name.toLowerCase().includes(searchVal) || p.server.toLowerCase().includes(searchVal));
  tbody.innerHTML = '';
  
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">Прокси-узлы не найдены</td></tr>';
    return;
  }
  
  filtered.forEach(p => {
    const tr = document.createElement('tr');
    const cleanName = p.name.replace(/[^a-zA-Z0-9-_]/g, '_');
    tr.id = 'proxy-row-' + cleanName;
    
    const tdName = document.createElement('td');
    tdName.style.fontWeight = '600';
    tdName.textContent = p.name;
    
    const tdType = document.createElement('td');
    const spanType = document.createElement('span');
    spanType.className = 'route-badge';
    spanType.textContent = p.type.toUpperCase();
    tdType.appendChild(spanType);
    
    const tdServer = document.createElement('td');
    tdServer.style.fontFamily = 'monospace';
    tdServer.style.fontSize = '0.9rem';
    tdServer.textContent = p.server;
    
    const tdPing = document.createElement('td');
    const spanPing = document.createElement('span');
    spanPing.id = 'ping-badge-' + cleanName;
    spanPing.className = 'ping-badge timeout';
    
    if (p.history && p.history.length > 0) {
      const lastDelay = p.history[p.history.length - 1].delay;
      if (lastDelay > 0) {
        spanPing.textContent = lastDelay + ' ms';
        if (lastDelay < 200) spanPing.className = 'ping-badge fast';
        else if (lastDelay < 500) spanPing.className = 'ping-badge medium';
        else spanPing.className = 'ping-badge slow';
      } else {
        spanPing.textContent = 'timeout';
        spanPing.className = 'ping-badge timeout';
      }
    } else {
      spanPing.textContent = '-';
    }
    tdPing.appendChild(spanPing);
    
    const tdAction = document.createElement('td');
    tdAction.style.textAlign = 'center';
    const btnTest = document.createElement('button');
    btnTest.className = 'btn';
    btnTest.style.padding = '6px 12px';
    btnTest.textContent = 'Тест';
    btnTest.onclick = async function() {
      btnTest.disabled = true;
      btnTest.textContent = '...';
      spanPing.textContent = 'ping...';
      spanPing.className = 'ping-badge timeout';
      
      try {
        const delay = await pingSingleProxy(p.name);
        if (delay > 0) {
          spanPing.textContent = delay + ' ms';
          if (delay < 200) spanPing.className = 'ping-badge fast';
          else if (delay < 500) spanPing.className = 'ping-badge medium';
          else spanPing.className = 'ping-badge slow';
        } else {
          spanPing.textContent = 'timeout';
          spanPing.className = 'ping-badge timeout';
        }
      } catch (e) {
        spanPing.textContent = 'error';
        spanPing.className = 'ping-badge timeout';
      } finally {
        btnTest.disabled = false;
        btnTest.textContent = 'Тест';
      }
    };
    tdAction.appendChild(btnTest);
    
    tr.appendChild(tdName);
    tr.appendChild(tdType);
    tr.appendChild(tdServer);
    tr.appendChild(tdPing);
    tr.appendChild(tdAction);
    
    tbody.appendChild(tr);
  });
}

async function pingSingleProxy(name) {
  try {
    const res = await fetch('/api/proxies/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.delay || 0;
  } catch (e) {
    return 0;
  }
}

async function pingAllProxies() {
  const btn = document.getElementById('btn-ping-all');
  btn.disabled = true;
  btn.textContent = 'Проверка...';
  
  const searchVal = document.getElementById('ping-search-box').value.toLowerCase();
  const filtered = proxiesList.filter(p => p.name.toLowerCase().includes(searchVal) || p.server.toLowerCase().includes(searchVal));
  
  showToast(`Запущен пинг-тест для ${filtered.length} узлов...\n(Пожалуйста, подождите)`);
  
  const limit = 5;
  let index = 0;
  
  async function worker() {
    while (index < filtered.length) {
      const p = filtered[index++];
      const cleanName = p.name.replace(/[^a-zA-Z0-9-_]/g, '_');
      const badge = document.getElementById('ping-badge-' + cleanName);
      if (badge) {
        badge.textContent = '...';
        badge.className = 'ping-badge timeout';
        
        const delay = await pingSingleProxy(p.name);
        if (delay > 0) {
          badge.textContent = delay + ' ms';
          if (delay < 200) badge.className = 'ping-badge fast';
          else if (delay < 500) badge.className = 'ping-badge medium';
          else badge.className = 'ping-badge slow';
        } else {
          badge.textContent = 'timeout';
          badge.className = 'ping-badge timeout';
        }
      }
    }
  }
  
  const workers = Array.from({ length: limit }, worker);
  await Promise.all(workers);
  
  showToast('Пинг-тест всех узлов завершен!');
  btn.disabled = false;
  btn.textContent = '⚡ Проверить все';
}



// Функция для вызова перезапуска сервера на роутере
async function triggerServerRestart() {
  let overlay = document.getElementById('dimmer-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'dimmer-overlay';
    overlay.className = 'dimmer-overlay';
    overlay.innerHTML = '<div class="dimmer-spinner"></div>' +
                        '<div class="dimmer-text">Перезапуск веб-контроллера...</div>';
    document.body.appendChild(overlay);
  }
  
  setTimeout(() => overlay.classList.add('active'), 20);
  
  try {
    fetch('/api/server/restart', { method: 'POST' });
  } catch (err) {}
  
  let secondsLeft = 3;
  showToast('Веб-панель перезагрузится через ' + secondsLeft + ' сек...', 'success');
  
  const countdownInterval = setInterval(() => {
    secondsLeft--;
    if (secondsLeft > 0) {
      showToast('Веб-панель перезагрузится через ' + secondsLeft + ' сек...', 'success');
    } else {
      clearInterval(countdownInterval);
    }
  }, 1000);
  
  setTimeout(() => {
    window.location.reload();
  }, 3200);
}

// Горячие клавиши: Shift + R для перезапуска
document.addEventListener('keydown', function(event) {
  if (event.shiftKey && event.code === 'KeyR') {
    const activeElem = document.activeElement;
    if (activeElem && (activeElem.tagName === 'INPUT' || activeElem.tagName === 'TEXTAREA')) {
      return;
    }
    event.preventDefault();
    triggerServerRestart();
  }
});

// Попытка моментально инициализировать данные мостов из локального кэша
try {
  const cachedBridges = localStorage.getItem('mc_tor_bridges');
  if (cachedBridges) {
    const parsed = JSON.parse(cachedBridges);
    torData = parsed.bridges;
  }
} catch (e) {}

// Инициализация при старте страницы
window.onload = function() {
  configEditor = CodeMirror.fromTextArea(document.getElementById("config-editor-textarea"), {
    lineNumbers: true,
    mode: "text/x-yaml",
    lineWrapping: true,
    tabSize: 2,
    indentUnit: 2
  });
  loadPanelVersion();
  loadMihomoVersion();
  updateXkeenStatus().then(() => {
    if (window.isXkeenRunning && typeof loadProxiesDashboard === 'function') {
      loadProxiesDashboard();
    }
  });
  initCustomTooltips();
  initCustomSelects();
  setInterval(updateXkeenStatus, 15000); // Опрос раз в 15 секунд
};

async function loadPanelVersion() {
  try {
    const res = await fetch('/version.json');
    if (res.ok) {
      const data = await res.json();
      const versionVal = document.getElementById('panel-version-val');
      const branchVal = document.getElementById('panel-branch-val');
      if (versionVal) versionVal.textContent = data.version;
      if (branchVal) {
        const isDev = isDevVersion(data.version);
        branchVal.textContent = isDev ? 'Dev' : 'Main';
        if (!isDev) {
          branchVal.style.background = 'var(--success-container)';
          branchVal.style.color = 'var(--success)';
          branchVal.style.borderColor = 'rgba(61, 220, 132, 0.25)';
        } else {
          // Dev branch style
          branchVal.style.background = 'rgba(255, 183, 77, 0.15)';
          branchVal.style.color = '#ffb74d';
          branchVal.style.borderColor = 'rgba(255, 183, 77, 0.3)';
        }
      }
    }
  } catch (err) {
    console.error('Error loading panel version:', err);
  }
}

// Добавляем переход на вкладку обновлений при клике на версию
document.addEventListener('DOMContentLoaded', () => {
  const versionPanel = document.getElementById('panel-version-info');
  if (versionPanel) {
    versionPanel.addEventListener('click', () => {
      switchTab('updates');
    });
  }
  
  // Добавляем закрытие модалки при клике на overlay
  const mihomoModal = document.getElementById('mihomo-update-modal');
  if (mihomoModal) {
    mihomoModal.addEventListener('click', (e) => {
      if (e.target === mihomoModal) {
        closeMihomoUpdateModal();
      }
    });
  }
});

// === Управление XKeen (запуск, остановка, рестарт) ===
window.isXkeenRunning = false;

async function updateXkeenStatus() {
  const badge = document.getElementById('xkeen-status-badge');
  const dot = document.getElementById('xkeen-status-dot');
  const text = document.getElementById('xkeen-status-text');
  const toggleBtn = document.getElementById('btn-xkeen-toggle');
  const restartBtn = document.getElementById('btn-xkeen-restart');
  const toggleSvg = document.getElementById('svg-xkeen-toggle');
  
  if (!badge || !dot || !text || !toggleBtn || !restartBtn || !toggleSvg) return;
  
  try {
    const res = await fetch('/api/xkeen/status');
    const data = await res.json();
    
    if (data.success) {
      window.isXkeenRunning = data.running;
      updateXkeenTabPlaceholders();

      if (data.running) {
        text.textContent = 'Mihomo API подключен';
        badge.style.background = 'var(--success-container)';
        badge.style.borderColor = 'rgba(61, 220, 132, 0.25)';
        badge.style.color = 'var(--success)';
        dot.style.backgroundColor = 'var(--success)';
        dot.style.boxShadow = '0 0 10px var(--success)';
        dot.style.animation = 'pulse 2s infinite var(--m3-easing)';
        
        // Иконка Stop (квадрат)
        toggleSvg.innerHTML = '<path d="M6 19h12V5H6v14z"/>';
        toggleBtn.title = 'Остановить XKeen';
        toggleBtn.disabled = false;
        restartBtn.disabled = false;
      } else {
        text.textContent = 'XKeen остановлен';
        badge.style.background = 'var(--danger-container)';
        badge.style.borderColor = 'rgba(255, 138, 128, 0.25)';
        badge.style.color = 'var(--danger)';
        dot.style.backgroundColor = 'var(--danger)';
        dot.style.boxShadow = 'none';
        dot.style.animation = 'none';
        
        // Иконка Play (треугольник)
        toggleSvg.innerHTML = '<path d="M8 5v14l11-7z"/>';
        toggleBtn.title = 'Запустить XKeen';
        toggleBtn.disabled = false;
        restartBtn.disabled = true; // Нельзя перезапустить остановленную службу
      }
    }
  } catch (err) {
    text.textContent = 'Ошибка статуса';
    dot.style.backgroundColor = 'var(--danger)';
    window.isXkeenRunning = false;
    updateXkeenTabPlaceholders();
  }
}

function updateXkeenTabPlaceholders() {
  const dependentTabs = ['proxies-dashboard', 'ping', 'traffic', 'connections', 'packet-monitor', 'logs', 'trace'];
  const isRunning = window.isXkeenRunning;

  dependentTabs.forEach(tabId => {
    const tabEl = document.getElementById('tab-content-' + tabId);
    if (!tabEl) return;

    tabEl.style.position = 'relative';

    let overlay = tabEl.querySelector('.xkeen-stopped-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'xkeen-stopped-overlay';
      overlay.innerHTML = `
        <div style="background:var(--danger-container); border:1px solid rgba(255,138,128,0.15); color:var(--danger); padding:10px 20px; border-radius:30px; font-weight:500; font-size:0.95rem; margin-bottom:16px; display:inline-flex; align-items:center; gap:8px;">
          <span style="width:8px; height:8px; background:var(--danger); border-radius:50%;"></span>
          Сервис остановлен
        </div>
        <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:20px; max-width:320px; font-family:'Inter', sans-serif; line-height: 1.5;">
          Для просмотра этой вкладки необходимо запустить прокси-службу Mihomo (XKeen).
        </p>
        <button class="btn btn-primary btn-xkeen-start-inline" style="display:inline-flex; align-items:center; gap:8px; padding:10px 20px; font-size:0.9rem; cursor:pointer;">
          <svg viewBox="0 0 24 24" style="width:18px; height:18px; fill:currentColor;"><path d="M8 5v14l11-7z"/></svg>
          Запустить службу
        </button>
      `;
      
      const startBtn = overlay.querySelector('.btn-xkeen-start-inline');
      if (startBtn) {
        startBtn.onclick = async () => {
          startBtn.disabled = true;
          const mainToggle = document.getElementById('btn-xkeen-toggle');
          if (mainToggle) {
            mainToggle.click();
          }
        };
      }
      tabEl.appendChild(overlay);
    }

    if (isRunning) {
      overlay.style.display = 'none';
      const startBtn = overlay.querySelector('.btn-xkeen-start-inline');
      if (startBtn) startBtn.disabled = false;
    } else {
      overlay.style.display = 'flex';
    }
  });
}

// Обработчики кликов управления XKeen
async function handleXkeenToggle() {
  const btn = document.getElementById('btn-xkeen-toggle');
  if (btn.disabled) return;
  const restartBtn = document.getElementById('btn-xkeen-restart');
  btn.disabled = true;
  restartBtn.disabled = true;
  
  showToast('Выполняется переключение службы XKeen...', 'success');
  try {
    const res = await fetch('/api/xkeen/toggle', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(data.running ? 'Служба XKeen успешно запущена!' : 'Служба XKeen остановлена!', 'success');
    } else {
      showToast('Ошибка при переключении XKeen', 'error');
    }
  } catch (e) {
    showToast('Ошибка сети', 'error');
  } finally {
    await updateXkeenStatus();
  }
}

async function handleXkeenRestart() {
  const btn = document.getElementById('btn-xkeen-restart');
  if (btn.disabled) return;
  const toggleBtn = document.getElementById('btn-xkeen-toggle');
  btn.disabled = true;
  toggleBtn.disabled = true;
  
  const svg = btn.querySelector('svg');
  if (svg) svg.style.transform = 'rotate(360deg)';
  
  showToast('Выполняется перезапуск службы XKeen...', 'success');
  try {
    const res = await fetch('/api/xkeen/restart', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Служба XKeen успешно перезапущена!', 'success');
    } else {
      showToast('Ошибка при перезапуске XKeen', 'error');
    }
  } catch (e) {
    showToast('Ошибка сети', 'error');
  } finally {
    if (svg) svg.style.transform = 'none';
    await updateXkeenStatus();
  }
}

const btnXkeenToggleEl = document.getElementById('btn-xkeen-toggle');
const btnXkeenRestartEl = document.getElementById('btn-xkeen-restart');

if (btnXkeenToggleEl) {
  btnXkeenToggleEl.onclick = handleXkeenToggle;
  btnXkeenToggleEl.oncontextmenu = function(e) {
    e.preventDefault();
    handleXkeenToggle();
  };
}

if (btnXkeenRestartEl) {
  btnXkeenRestartEl.onclick = handleXkeenRestart;
  btnXkeenRestartEl.oncontextmenu = function(e) {
    e.preventDefault();
    handleXkeenRestart();
  };
}

// --- ДИНАМИЧЕСКИЕ ПРАВИЛА ---
let dynamicRulesList = [];
let routingTargetsList = [];

async function loadDynamicRulesTab() {
  await loadRoutingGroups();
  await loadDynamicRules();
}

async function loadRoutingGroups() {
  try {
    const res = await fetch('/api/config/routing-groups');
    if (!res.ok) throw new Error('Ошибка при загрузке направлений');
    const data = await res.json();
    if (data.success) {
      routingTargetsList = data.targets || [];
      const select = document.getElementById('rule-target-select');
      select.innerHTML = '';
      routingTargetsList.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        if (t === '🚀Auto-Best' || t === 'Auto-Best') {
          opt.selected = true;
        }
        select.appendChild(opt);
      });
    }
  } catch (err) {
    showToast('Не удалось загрузить прокси-группы: ' + err.message, 'error');
  }
}

async function loadDynamicRules() {
  const tbody = document.getElementById('dynamic-rules-list');
  const emptyState = document.getElementById('rules-empty-state');
  
  tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 30px 0;">Загрузка правил...</td></tr>';
  emptyState.style.display = 'none';
  tbody.parentElement.style.display = 'table';

  try {
    const res = await fetch('/api/config/dynamic-rules');
    if (!res.ok) throw new Error('Ошибка при загрузке правил');
    const data = await res.json();
    
    if (data.success) {
      dynamicRulesList = data.rules || [];
      renderRulesTable();
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--md-sys-color-error); padding: 30px 0;">Ошибка: ${err.message}</td></tr>`;
    showToast('Не удалось загрузить быстрые правила: ' + err.message, 'error');
  }
}

function renderRulesTable() {
  const tbody = document.getElementById('dynamic-rules-list');
  const countText = document.getElementById('rules-count-text');
  const emptyState = document.getElementById('rules-empty-state');
  const searchVal = document.getElementById('rules-search-box').value.toLowerCase();

  const filtered = dynamicRulesList.filter(r => 
    r.value.toLowerCase().includes(searchVal) || 
    r.target.toLowerCase().includes(searchVal) ||
    r.type.toLowerCase().includes(searchVal)
  );

  const dynamicCount = filtered.filter(r => r.dynamic).length;
  countText.textContent = `Всего: ${filtered.length} (пользовательских: ${dynamicCount})`;

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    tbody.parentElement.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }

  tbody.parentElement.style.display = 'table';
  emptyState.style.display = 'none';
  tbody.innerHTML = '';

  filtered.forEach((r, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'rule-row';
    tr.dataset.index = idx;
    tr.dataset.lineIndex = r.lineIndex;

    if (!r.dynamic) {
      tr.classList.add('system-rule');
    }

    // Drag Handle & Index Cell
    const tdDrag = document.createElement('td');
    tdDrag.className = 'rule-drag-cell';
    const dragHandle = document.createElement('div');
    dragHandle.className = 'rule-drag-handle';
    dragHandle.title = 'Зажмите и перетащите для изменения приоритета правила';
    dragHandle.innerHTML = `
      <span class="rule-order-num">${idx + 1}</span>
      <span class="rule-drag-grip">⠿</span>
    `;
    tdDrag.appendChild(dragHandle);

    const tdType = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'rule-type-badge ' + r.type.toLowerCase();
    badge.textContent = r.type;
    tdType.appendChild(badge);

    const tdValue = document.createElement('td');
    tdValue.style.fontWeight = '500';
    tdValue.style.fontFamily = 'monospace';
    tdValue.textContent = r.value || '(Все домены / MATCH)';

    const tdTarget = document.createElement('td');
    const select = document.createElement('select');
    select.className = 'rule-target-select-inline';
    
    const targetsToUse = routingTargetsList.includes(r.target) ? routingTargetsList : [r.target, ...routingTargetsList];
    targetsToUse.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      if (t === r.target) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    select.onchange = async () => {
      const newTarget = select.value;
      if (newTarget !== r.target) {
        await updateDynamicRuleTarget(r, newTarget);
      }
    };

    tdTarget.appendChild(select);

    const tdAction = document.createElement('td');
    tdAction.style.textAlign = 'center';
    
    if (r.dynamic) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-danger';
      deleteBtn.style.padding = '4px 10px';
      deleteBtn.style.fontSize = '0.85rem';
      deleteBtn.innerHTML = '🗑️';
      deleteBtn.title = 'Удалить пользовательское правило';
      deleteBtn.onclick = () => deleteDynamicRule(r);
      tdAction.appendChild(deleteBtn);
    } else {
      const lockSpan = document.createElement('span');
      lockSpan.style.color = 'var(--text-muted)';
      lockSpan.style.fontSize = '0.9rem';
      lockSpan.title = 'Системное правило из конфигурации (можно менять приоритет перетаскиванием)';
      lockSpan.textContent = '🔒';
      tdAction.appendChild(lockSpan);
    }

    tr.appendChild(tdDrag);
    tr.appendChild(tdType);
    tr.appendChild(tdValue);
    tr.appendChild(tdTarget);
    tr.appendChild(tdAction);

    // Initialize Y-axis constrained Drag & Drop on the handle
    initRulePointerDrag(tr, dragHandle, idx, filtered);

    tbody.appendChild(tr);
  });
  initCustomSelects();
}

function initRulePointerDrag(tr, dragHandle, idx, filtered) {
  dragHandle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // Only primary button
    e.preventDefault();

    const tbody = document.getElementById('dynamic-rules-list');
    const startIdx = Array.from(tbody.querySelectorAll('.rule-row')).indexOf(tr);
    if (startIdx === -1) return;

    const rowRect = tr.getBoundingClientRect();
    const startClientY = e.clientY;

    // Create floating avatar locked to exact table horizontal bounds
    const avatar = document.createElement('div');
    avatar.className = 'rule-drag-avatar';
    avatar.style.top = `${rowRect.top}px`;
    avatar.style.left = `${rowRect.left}px`;
    avatar.style.width = `${rowRect.width}px`;
    avatar.style.height = `${rowRect.height}px`;

    const avatarTable = document.createElement('table');
    const avatarTbody = document.createElement('tbody');
    const clonedTr = tr.cloneNode(true);
    clonedTr.classList.remove('rule-row-placeholder', 'just-dropped');

    Array.from(tr.children).forEach((td, cIdx) => {
      if (clonedTr.children[cIdx]) {
        clonedTr.children[cIdx].style.width = `${td.offsetWidth}px`;
        clonedTr.children[cIdx].style.minWidth = `${td.offsetWidth}px`;
        clonedTr.children[cIdx].style.maxWidth = `${td.offsetWidth}px`;
      }
    });

    avatarTbody.appendChild(clonedTr);
    avatarTable.appendChild(avatarTbody);
    avatar.appendChild(avatarTable);
    document.body.appendChild(avatar);

    tr.classList.add('rule-row-placeholder');
    let placeholder = tr;

    function onPointerMove(moveEvent) {
      // STRICT Y-AXIS LOCK:
      const deltaY = moveEvent.clientY - startClientY;
      avatar.style.transform = `translate3d(0, ${deltaY}px, 0) scale(1.01)`;

      // Auto-scroll window if near top/bottom viewport
      const threshold = 100;
      if (moveEvent.clientY < threshold) {
        const speed = Math.min(22, (threshold - moveEvent.clientY) / 3);
        window.scrollBy(0, -speed);
      } else if (moveEvent.clientY > window.innerHeight - threshold) {
        const speed = Math.min(22, (moveEvent.clientY - (window.innerHeight - threshold)) / 3);
        window.scrollBy(0, speed);
      }

      // Check hover position relative to rows
      const currentRows = Array.from(tbody.querySelectorAll('.rule-row'));
      const cursorY = moveEvent.clientY;

      for (let i = 0; i < currentRows.length; i++) {
        const otherRow = currentRows[i];
        if (otherRow === placeholder) continue;

        const rect = otherRow.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;

        if (cursorY < midY && i === 0) {
          tbody.insertBefore(placeholder, otherRow);
          break;
        } else if (cursorY > midY && i === currentRows.length - 1) {
          tbody.appendChild(placeholder);
          break;
        } else if (cursorY >= rect.top && cursorY <= rect.bottom) {
          if (cursorY < midY) {
            tbody.insertBefore(placeholder, otherRow);
          } else {
            tbody.insertBefore(placeholder, otherRow.nextSibling);
          }
          break;
        }
      }

      // Update visible sequence numbers in real time
      const updatedRows = Array.from(tbody.querySelectorAll('.rule-row'));
      updatedRows.forEach((r, rIdx) => {
        const numSpan = r.querySelector('.rule-order-num');
        if (numSpan) numSpan.textContent = rIdx + 1;
      });
    }

    async function onPointerUp(upEvent) {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      const finalRect = placeholder.getBoundingClientRect();
      avatar.style.transition = 'transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.15s ease';
      avatar.style.transform = `translate3d(0, ${finalRect.top - rowRect.top}px, 0) scale(1)`;

      setTimeout(async () => {
        if (avatar.parentNode) avatar.parentNode.removeChild(avatar);
        placeholder.classList.remove('rule-row-placeholder');

        const finalRows = Array.from(tbody.querySelectorAll('.rule-row'));
        const newIdx = finalRows.indexOf(placeholder);

        if (newIdx !== -1 && newIdx !== startIdx) {
          const fromRule = filtered[startIdx];
          const toRule = filtered[newIdx];
          const position = newIdx > startIdx ? 'after' : 'before';

          await reorderDynamicRule(fromRule, toRule, position);
        } else {
          placeholder.classList.add('just-dropped');
          setTimeout(() => placeholder.classList.remove('just-dropped'), 800);
        }
      }, 180);
    }

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  });
}

function moveLineInYamlText(yamlText, fromRule, toRule, position) {
  const lines = yamlText.split(/\r?\n/);
  
  let srcIdx = -1;
  let dstIdx = -1;

  if (fromRule && fromRule.originalLine) {
    srcIdx = lines.findIndex(l => l.trim() === fromRule.originalLine.trim());
  }
  if (toRule && toRule.originalLine) {
    dstIdx = lines.findIndex(l => l.trim() === toRule.originalLine.trim());
  }

  if (srcIdx === -1 && fromRule && fromRule.lineIndex !== undefined && lines[fromRule.lineIndex]) {
    srcIdx = fromRule.lineIndex;
  }
  if (dstIdx === -1 && toRule && toRule.lineIndex !== undefined && lines[toRule.lineIndex]) {
    dstIdx = toRule.lineIndex;
  }

  if (srcIdx === -1 || dstIdx === -1 || srcIdx === dstIdx) {
    return yamlText;
  }

  const [movedLine] = lines.splice(srcIdx, 1);
  let targetInsertIdx = dstIdx;
  if (srcIdx < dstIdx) {
    targetInsertIdx = dstIdx - 1;
  }
  if (position === 'after') {
    targetInsertIdx += 1;
  }

  lines.splice(targetInsertIdx, 0, movedLine);
  return lines.join('\n');
}

async function reorderDynamicRule(fromRule, toRule, position) {
  if (!fromRule || !toRule) return;

  const fromMasterIdx = dynamicRulesList.findIndex(r => r === fromRule || (r.type === fromRule.type && r.value === fromRule.value && r.target === fromRule.target && r.lineIndex === fromRule.lineIndex));
  const toMasterIdx = dynamicRulesList.findIndex(r => r === toRule || (r.type === toRule.type && r.value === toRule.value && r.target === toRule.target && r.lineIndex === toRule.lineIndex));

  if (fromMasterIdx === -1 || toMasterIdx === -1 || fromMasterIdx === toMasterIdx) return;

  const [movedItem] = dynamicRulesList.splice(fromMasterIdx, 1);
  let insertIdx = dynamicRulesList.findIndex(r => r === toRule || (r.type === toRule.type && r.value === toRule.value && r.target === toRule.target && r.lineIndex === toRule.lineIndex));
  if (position === 'after') {
    insertIdx += 1;
  }
  dynamicRulesList.splice(insertIdx, 0, movedItem);
  renderRulesTable();

  const tbody = document.getElementById('dynamic-rules-list');
  const rows = tbody.querySelectorAll('.rule-row');
  const targetRow = Array.from(rows).find(r => r.dataset.lineIndex == movedItem.lineIndex);
  if (targetRow) {
    targetRow.classList.add('just-dropped');
    setTimeout(() => targetRow.classList.remove('just-dropped'), 1000);
  }

  try {
    let saved = false;

    // 1. Try dedicated endpoint first if available
    try {
      const res = await fetch('/api/config/dynamic-rules/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromLineIndex: fromRule.lineIndex,
          toLineIndex: toRule.lineIndex,
          position: position,
          fromRule: {
            type: fromRule.type,
            value: fromRule.value,
            target: fromRule.target,
            originalLine: fromRule.originalLine
          },
          toRule: {
            type: toRule.type,
            value: toRule.value,
            target: toRule.target,
            originalLine: toRule.originalLine
          }
        })
      });

      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.success) {
          saved = true;
          if (data.rules) {
            dynamicRulesList = data.rules;
            renderRulesTable();
          }
        }
      }
    } catch (e) {}

    // 2. Direct on-the-fly config saving fallback (works instantly without any server restart)
    if (!saved) {
      const cfgRes = await fetch('/api/config?file=config');
      if (!cfgRes.ok) throw new Error('Не удалось прочитать config.yaml');
      const currentYaml = await cfgRes.text();
      const newYaml = moveLineInYamlText(currentYaml, fromRule, toRule, position);

      const saveRes = await fetch('/api/config?file=config', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: newYaml
      });

      if (!saveRes.ok) {
        const errText = await saveRes.text();
        throw new Error(errText || 'Ошибка сохранения конфигурации');
      }

      await loadDynamicRules();
    }

    showToast('⚡ Порядок правил обновлен и применен', 'success');
  } catch (err) {
    showToast('Не удалось переместить правило: ' + err.message, 'error');
    await loadDynamicRules();
  }
}

function filterRulesTable() {
  renderRulesTable();
}

async function submitAddRule() {
  const type = document.getElementById('rule-type-select').value;
  const valueInput = document.getElementById('rule-value-input');
  const target = document.getElementById('rule-target-select').value;
  const value = valueInput.value.trim();

  if (!value) return;

  showToast('Добавление правила и обновление конфигурации...', 'info');

  try {
    const res = await fetch('/api/config/dynamic-rules', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type, value, target })
    });

    const data = await res.json();
    if (data.success) {
      showToast('Правило успешно добавлено и применено!', 'success');
      valueInput.value = '';
      await loadDynamicRules();
    } else {
      showToast('Ошибка при добавлении правила: ' + data.error, 'error');
    }
  } catch (err) {
    showToast('Ошибка сети: ' + err.message, 'error');
  }
}

async function deleteDynamicRule(rule) {
  if (!confirm('Вы уверены, что хотите удалить это правило?')) return;

  showToast('Удаление правила и обновление конфигурации...', 'info');

  try {
    const res = await fetch('/api/config/dynamic-rules', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type: rule.type, value: rule.value, target: rule.target })
    });

    const data = await res.json();
    if (data.success) {
      showToast('Правило успешно удалено!', 'success');
      await loadDynamicRules();
    } else {
      showToast('Ошибка при удалении правила: ' + data.error, 'error');
    }
  } catch (err) {
    showToast('Ошибка сети: ' + err.message, 'error');
  }
}

async function updateDynamicRuleTarget(rule, newTarget) {
  showToast('Обновление направления правила...', 'info');
  try {
    const res = await fetch('/api/config/dynamic-rules', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        lineIndex: rule.lineIndex,
        originalLine: rule.originalLine,
        newTarget: newTarget
      })
    });

    const data = await res.json();
    if (data.success) {
      showToast('Направление успешно обновлено!', 'success');
      await loadDynamicRules();
    } else {
      showToast('Ошибка при обновлении направления: ' + data.error, 'error');
      await loadDynamicRules();
    }
  } catch (err) {
    showToast('Ошибка сети: ' + err.message, 'error');
    await loadDynamicRules();
  }
}

// Инициализация кастомных быстрых подсказок
function initCustomTooltips() {
  let tooltipEl = document.getElementById('global-custom-tooltip');
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'global-custom-tooltip';
    tooltipEl.className = 'custom-tooltip';
    document.body.appendChild(tooltipEl);
  }

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('.pgc-dot, [data-tooltip], [title]');
    if (!target) return;

    let text = '';
    if (target.hasAttribute('title')) {
      text = target.getAttribute('title');
      target.setAttribute('data-tooltip', text);
      target.removeAttribute('title');
    } else if (target.hasAttribute('data-tooltip')) {
      text = target.getAttribute('data-tooltip');
    }

    if (!text) return;

    tooltipEl.innerHTML = text;
    tooltipEl.classList.add('visible');

    const updatePosition = (event) => {
      const x = event.clientX + 12;
      const y = event.clientY + 12;
      
      const rect = tooltipEl.getBoundingClientRect();
      let left = x;
      let top = y;
      
      if (left + rect.width > window.innerWidth) {
        left = event.clientX - rect.width - 12;
      }
      if (top + rect.height > window.innerHeight) {
        top = event.clientY - rect.height - 12;
      }
      
      tooltipEl.style.left = left + 'px';
      tooltipEl.style.top = top + 'px';
    };

    updatePosition(e);

    const onMouseMove = (event) => {
      updatePosition(event);
    };

    const onMouseLeave = () => {
      tooltipEl.classList.remove('visible');
      target.removeEventListener('mousemove', onMouseMove);
      target.removeEventListener('mouseleave', onMouseLeave);
    };

    target.addEventListener('mousemove', onMouseMove);
    target.addEventListener('mouseleave', onMouseLeave);
  });
}

// Инициализация кастомных красивых выпадающих списков
function convertToCustomSelect(selectEl) {
  if (!selectEl || selectEl.style.display === 'none' || selectEl.parentElement.classList.contains('custom-select-wrapper')) {
    return;
  }

  // Create wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select-wrapper';
  if (selectEl.className) {
    selectEl.className.trim().split(/\s+/).forEach(cls => {
      if (cls) wrapper.classList.add(cls + '-container');
    });
  }

  if (selectEl.style.width) {
    wrapper.style.width = selectEl.style.width;
  }
  
  if (selectEl.disabled) {
    wrapper.classList.add('disabled');
  }

  // Create trigger
  const trigger = document.createElement('div');
  trigger.className = 'custom-select-trigger';
  
  // Create dropdown
  const dropdown = document.createElement('div');
  dropdown.className = 'custom-select-dropdown';

  // Function to sync trigger text and selected option class
  const syncSelect = () => {
    const selectedOpt = selectEl.options[selectEl.selectedIndex];
    trigger.textContent = selectedOpt ? selectedOpt.textContent : 'Выбрать...';
    
    // Update selected class in dropdown
    const options = dropdown.querySelectorAll('.custom-select-option');
    options.forEach((opt, idx) => {
      if (idx === selectEl.selectedIndex) {
        opt.classList.add('selected');
      } else {
        opt.classList.remove('selected');
      }
    });

    // Sync disabled state
    if (selectEl.disabled) {
      wrapper.classList.add('disabled');
    } else {
      wrapper.classList.remove('disabled');
    }
  };

  // Populate dropdown options
  const rebuildOptions = () => {
    dropdown.innerHTML = '';
    Array.from(selectEl.options).forEach((origOpt, idx) => {
      const opt = document.createElement('div');
      opt.className = 'custom-select-option';
      opt.textContent = origOpt.textContent;
      if (idx === selectEl.selectedIndex) opt.classList.add('selected');
      
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectEl.disabled) return;
        selectEl.selectedIndex = idx;
        
        // Trigger original events
        selectEl.dispatchEvent(new Event('change'));
        
        syncSelect();
        wrapper.classList.remove('open');
      });
      dropdown.appendChild(opt);
    });
  };

  rebuildOptions();

  // Handle trigger click
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectEl.disabled) return;
    
    // Close other custom selects first and reset parent tr z-index
    document.querySelectorAll('.custom-select-wrapper').forEach(w => {
      if (w !== wrapper) {
        w.classList.remove('open');
        w.classList.remove('open-up');
        const parentTr = w.closest('tr');
        if (parentTr) parentTr.style.zIndex = '';
      }
    });
    
    const wasOpen = wrapper.classList.contains('open');
    if (!wasOpen) {
      const rect = wrapper.getBoundingClientRect();
      const dropdownHeight = dropdown.scrollHeight || (selectEl.options.length * 38 + 10);
      const spaceBelow = window.innerHeight - rect.bottom;
      
      // Open upwards ONLY when genuinely no space below for this specific dropdown
      if (spaceBelow < dropdownHeight + 10 && rect.top > dropdownHeight + 10) {
        wrapper.classList.add('open-up');
      } else {
        wrapper.classList.remove('open-up');
      }
      wrapper.classList.add('open');
      const tr = wrapper.closest('tr');
      if (tr) {
        tr.style.zIndex = '99999';
        tr.style.position = 'relative';
      }

      const selected = dropdown.querySelector('.custom-select-option.selected');
      if (selected) {
        dropdown.scrollTop = selected.offsetTop - dropdown.offsetTop - 10;
      }
    } else {
      wrapper.classList.remove('open');
      const tr = wrapper.closest('tr');
      if (tr) tr.style.zIndex = '';
    }
  });

  // Watch for changes on the original select (e.g. if options list changes dynamically)
  const observer = new MutationObserver(() => {
    rebuildOptions();
    syncSelect();
  });
  observer.observe(selectEl, { childList: true, attributes: true, subtree: true });

  // Watch for direct select disabled property changes
  const checkDisabledTimer = setInterval(() => {
    if (!document.body.contains(wrapper)) {
      clearInterval(checkDisabledTimer);
      return;
    }
    if (selectEl.disabled && !wrapper.classList.contains('disabled')) {
      wrapper.classList.add('disabled');
    } else if (!selectEl.disabled && wrapper.classList.contains('disabled')) {
      wrapper.classList.remove('disabled');
    }
  }, 200);

  // Insert elements
  selectEl.parentNode.insertBefore(wrapper, selectEl);
  wrapper.appendChild(selectEl); // move select inside wrapper
  selectEl.style.display = 'none'; // hide original select
  wrapper.appendChild(trigger);
  wrapper.appendChild(dropdown);

  // Initial sync
  syncSelect();
  
  // Expose sync method on the native select
  selectEl.syncCustomSelect = syncSelect;
}

function initCustomSelects() {
  document.querySelectorAll('select').forEach(sel => {
    if (!sel.classList.contains('no-custom')) {
      convertToCustomSelect(sel);
    }
  });
}

// Global click/scroll listener to close dropdowns
function closeAllCustomSelects() {
  document.querySelectorAll('.custom-select-wrapper.open').forEach(wrapper => {
    wrapper.classList.remove('open');
    const parentTr = wrapper.closest('tr');
    if (parentTr) parentTr.style.zIndex = '';
  });
}

document.addEventListener('click', closeAllCustomSelects);
window.addEventListener('scroll', closeAllCustomSelects, { passive: true });
window.addEventListener('resize', closeAllCustomSelects, { passive: true });

// === ФУНКЦИОНАЛ УПРАВЛЕНИЯ ВЕРСИЯМИ И ОБНОВЛЕНИЯМИ ===
let selectedCommitSha = null;
let currentCommitSha = null;

async function loadVersionsList() {
  const container = document.getElementById('versions-list-container');
  const installBtn = document.getElementById('btn-install-version');
  
  container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 40px 0;">Загрузка списка версий с роутера...</div>';
  installBtn.disabled = true;
  selectedCommitSha = null;
  currentCommitSha = null;

  try {
    const res = await fetch('/api/system/versions');
    if (!res.ok) throw new Error('Ошибка при запросе версий');
    const payload = await res.json();
    if (!payload.success) throw new Error(payload.error || 'Неизвестная ошибка');

    const branch = payload.branch;
    const commits = payload.commits || [];

    // Обновляем метки ветки
    document.getElementById('active-branch-label').textContent = branch;
    const branchSelect = document.getElementById('update-branch-select');
    if (branchSelect) {
      branchSelect.value = branch;
      if (typeof branchSelect.syncCustomSelect === 'function') {
        branchSelect.syncCustomSelect();
      }
    }

    container.innerHTML = '';
    if (commits.length === 0) {
      container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 40px 0;">Коммиты не найдены.</div>';
      return;
    }

    // ДЕДУБЛИКАЦИЯ: Если есть одинаковые версии, объединяем их списки изменений
    const uniqueCommits = [];
    const versionMap = new Map(); // version -> array of commits

    commits.forEach(c => {
      if (!versionMap.has(c.version)) {
        versionMap.set(c.version, []);
      }
      versionMap.get(c.version).push(c);
    });

    versionMap.forEach((commitsList, versionKey) => {
      if (commitsList.length === 1) {
        const c = commitsList[0];
        if (Array.isArray(c.changes)) {
          c.changes = c.changes.filter(change => {
            const lower = change.toLowerCase();
            return !lower.startsWith('release:') && !lower.includes('bump version') && !lower.startsWith('version') && !lower.startsWith('local:');
          });
        }
        uniqueCommits.push(c);
      } else {
        // Объединяем все изменения из всех коммитов этой версии
        let mergedChanges = [];
        commitsList.forEach(c => {
          const list = Array.isArray(c.changes) ? c.changes : (c.message ? [c.message] : []);
          list.forEach(change => {
            const lower = change.toLowerCase();
            if (lower.startsWith('release:') || lower.includes('bump version') || lower.startsWith('version') || lower.startsWith('local:')) return;
            mergedChanges.push(change);
          });
        });
        
        // Очищаем дубликаты строк изменений
        mergedChanges = Array.from(new Set(mergedChanges));

        // Ищем коммит, где ветка - main или master
        let repCommit = commitsList.find(c => c.branch === 'main' || c.branch === 'master');
        if (!repCommit) {
          // Если нет коммита из main, оставляем самый первый (новейший)
          repCommit = commitsList[0];
        }

        // Создаем копию коммита с объединенными изменениями
        const mergedCommit = { ...repCommit, changes: mergedChanges };

        // Если хотя бы один из дубликатов был текущим (активным), помечаем как текущий
        const hasCurrent = commitsList.some(c => c.current);
        if (hasCurrent) {
          mergedCommit.current = true;
        }
        uniqueCommits.push(mergedCommit);
      }
    });

    // Сохраняем текущий SHA
    const currentCommit = uniqueCommits.find(c => c.current);
    if (currentCommit) {
      currentCommitSha = currentCommit.sha;
      selectedCommitSha = currentCommit.sha;
    }

    uniqueCommits.forEach(commit => {
      const card = document.createElement('div');
      card.className = 'version-item-card';
      if (commit.current) {
        card.classList.add('current', 'selected');
      }
      card.dataset.sha = commit.sha;

      const isDev = isDevVersion(commit.version);
      const typeBadgeHtml = isDev 
        ? '<span class="version-dev-badge">Dev</span>' 
        : '<span class="version-main-badge">Main</span>';
        
      const currentBadgeHtml = commit.current ? '<span class="version-current-badge">Текущая</span>' : '';

      let changesHtml = '';
      if (Array.isArray(commit.changes) && commit.changes.length > 0) {
        changesHtml = commit.changes.map(ch => `<li>${ch}</li>`).join('');
      } else {
        changesHtml = `<li>${commit.message}</li>`;
      }

      card.innerHTML = `
        <div class="version-item-header">
          <div class="version-item-info">
            <div class="version-item-title-row">
              <span class="version-item-title">${commit.version}</span>
              ${typeBadgeHtml}
              ${currentBadgeHtml}
            </div>
            <div class="version-item-meta">${commit.date}</div>
          </div>
          <div class="version-item-radio">
            <div class="version-item-radio-inner"></div>
          </div>
        </div>
        <div class="version-item-body">
          <div class="version-changes-title">Изменения:</div>
          <ul class="version-changes-list">
            ${changesHtml}
            <li class="version-author-line" style="color: rgba(255,255,255,0.4); font-size: 0.8rem; margin-top: 10px;">Автор: ${commit.author} | SHA: ${commit.sha.substring(0, 8)}</li>
          </ul>
        </div>
      `;

      card.addEventListener('click', () => {
        // Убираем выделение со всех карточек
        container.querySelectorAll('.version-item-card').forEach(c => c.classList.remove('selected'));
        // Выделяем текущую
        card.classList.add('selected');
        selectedCommitSha = commit.sha;

        // Если выбрали текущую запущенную версию, отключаем кнопку установки
        if (selectedCommitSha === currentCommitSha) {
          installBtn.disabled = true;
        } else {
          installBtn.disabled = false;
        }
      });

      container.appendChild(card);
    });

  } catch (err) {
    container.innerHTML = `<div style="text-align: center; color: var(--danger); padding: 40px 0;">Ошибка загрузки версий: ${err.message}</div>`;
    showToast('Ошибка при загрузке версий: ' + err.message, 'error');
  }
}

async function changeUpdateBranch() {
  const branchSelect = document.getElementById('update-branch-select');
  if (!branchSelect) return;
  const branchVal = branchSelect.value;

  if (!confirm(`Вы действительно хотите переключить панель на ветку "${branchVal}"?\nПри этом панель обновится на последнюю версию этой ветки, настройки сохранятся.`)) {
    return;
  }

  try {
    showToast('Переключение ветки...');
    const response = await fetch('/api/system/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: branchVal })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Ошибка при переключении');
    }

    triggerUpdateRestart('Переключение ветки и перезапуск панели...');
  } catch (err) {
    showToast('Ошибка при изменении ветки: ' + err.message, 'error');
  }
}

async function installSelectedVersion() {
  if (!selectedCommitSha) {
    showToast('Сначала выберите версию для установки', 'error');
    return;
  }

  if (selectedCommitSha === currentCommitSha) {
    showToast('Выбранная версия уже установлена', 'error');
    return;
  }

  if (!confirm(`Вы действительно хотите переключить панель на версию ${selectedCommitSha.substring(0, 7)}?\nВсе ваши настройки и базы данных будут сохранены.`)) {
    return;
  }

  try {
    showToast('Установка выбранной версии...');
    const response = await fetch('/api/system/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: selectedCommitSha })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Ошибка при установке');
    }

    triggerUpdateRestart('Установка версии и перезапуск панели...');
  } catch (err) {
    showToast('Ошибка при установке версии: ' + err.message, 'error');
  }
}

async function triggerUpdateRestart(customMessage) {
  let overlay = document.getElementById('dimmer-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'dimmer-overlay';
    overlay.className = 'dimmer-overlay';
    overlay.innerHTML = '<div class="dimmer-spinner"></div>' +
                        `<div class="dimmer-text">${customMessage || 'Перезапуск веб-контроллера...'}</div>`;
    document.body.appendChild(overlay);
  } else {
    overlay.querySelector('.dimmer-text').textContent = customMessage || 'Перезапуск веб-контроллера...';
  }
  
  setTimeout(() => overlay.classList.add('active'), 20);
  
  let secondsLeft = 5;
  showToast('Панель перезапускается, подождите ' + secondsLeft + ' сек...', 'success');
  
  const countdownInterval = setInterval(() => {
    secondsLeft--;
    if (secondsLeft > 0) {
      showToast('Панель перезапускается, подождите ' + secondsLeft + ' сек...', 'success');
    } else {
      clearInterval(countdownInterval);
    }
  }, 1000);
  
  setTimeout(() => {
    window.location.reload();
  }, 5000);
}

function isDevVersion(versionStr) {
  // Clean version string (remove 'v' prefix if present)
  const clean = versionStr.startsWith('v') ? versionStr.substring(1) : versionStr;
  
  // Check if it matches semver pattern X.Y.Z
  const parts = clean.split('.');
  if (parts.length === 3) {
    const major = parseInt(parts[0], 10);
    const minor = parseInt(parts[1], 10);
    const patch = parseInt(parts[2], 10);
    if (!isNaN(major) && !isNaN(minor) && !isNaN(patch)) {
      return patch !== 0; // Dev version if patch is not 0
    }
  }
  
  // If it's a short SHA or doesn't follow X.Y.0 pattern, treat as dev version unless it is exactly 1.0.0
  if (clean === '1.0.0') return false;
  
  return true;
}

// === Управление ядром Mihomo (версии, релизы, обновление) ===
window.mihomoArch = '';
let selectedMihomoRelease = null;

async function loadMihomoVersion() {
  try {
    const res = await fetch('/api/mihomo/version');
    if (res.ok) {
      const data = await res.json();
      const coreVersionVal = document.getElementById('core-version-val');
      if (coreVersionVal && data.success) {
        coreVersionVal.textContent = data.version;
        window.mihomoArch = data.arch;
      }
    }
  } catch (err) {
    console.error('Error loading Mihomo version:', err);
    const coreVersionVal = document.getElementById('core-version-val');
    if (coreVersionVal) {
      coreVersionVal.textContent = 'Ошибка';
    }
  }
}

function openMihomoUpdateModal() {
  const modal = document.getElementById('mihomo-update-modal');
  if (modal) {
    modal.style.display = 'flex';
    loadMihomoReleases();
  }
}

function closeMihomoUpdateModal() {
  const modal = document.getElementById('mihomo-update-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}

async function loadMihomoReleases() {
  const listContainer = document.getElementById('mihomo-releases-list');
  const installBtn = document.getElementById('btn-install-mihomo');
  
  if (!listContainer) return;
  
  listContainer.innerHTML = `
    <div class="releases-loading">
      <span class="spinner"></span> Загрузка списка релизов...
    </div>
  `;
  installBtn.disabled = true;
  selectedMihomoRelease = null;
  
  try {
    const res = await fetch('/api/mihomo/releases');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Неизвестная ошибка сервера');
    }
    
    const releases = data.releases || [];
    if (releases.length === 0) {
      listContainer.innerHTML = '<div class="releases-loading">Релизы не найдены.</div>';
      return;
    }
    
    const countBadge = document.querySelector('.github-count');
    if (countBadge) {
      countBadge.textContent = releases.length;
    }
    
    listContainer.innerHTML = '';
    
    releases.forEach((rel, idx) => {
      const card = document.createElement('div');
      card.className = 'release-card';
      
      const formattedDate = rel.published_at ? new Date(rel.published_at).toISOString().split('T')[0] : '';
      
      let changesHtml = '';
      if (rel.changes && rel.changes.length > 0) {
        const listItems = rel.changes.map(ch => {
          const cleanCh = ch.replace(/`([^`]+)`/g, '<code>$1</code>');
          return `<li>${cleanCh}</li>`;
        }).join('');
        
        changesHtml = `
          <div class="release-changes">
            <div class="changes-title">What's Changed</div>
            <ul class="changes-list">${listItems}</ul>
          </div>
        `;
      }
      
      const hasAsset = !!rel.download_url;
      const warningHtml = !hasAsset 
        ? `<div style="color: var(--md-sys-color-error); font-size: 0.8rem; margin-top: 6px; font-family: var(--font-inter);">
             Внимание: Файл под архитектуру "${window.mihomoArch || 'неизвестно'}" не найден в этом релизе.
           </div>`
        : '';
      
      card.innerHTML = `
        <div class="release-card-header">
          <div class="release-info">
            <div class="release-version">${rel.tag_name}</div>
            <div class="release-date">${formattedDate}</div>
            ${warningHtml}
          </div>
          <div class="release-radio-container">
            <input type="radio" name="mihomo-release-choice" class="release-radio-input" 
                   value="${idx}" ${!hasAsset ? 'disabled' : ''}>
          </div>
        </div>
        ${changesHtml}
      `;
      
      if (hasAsset) {
        card.addEventListener('click', (e) => {
          const radio = card.querySelector('.release-radio-input');
          if (e.target !== radio) {
            radio.checked = true;
          }
          
          document.querySelectorAll('.release-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          
          selectedMihomoRelease = rel;
          installBtn.disabled = false;
        });
      } else {
        card.style.opacity = '0.5';
        card.style.cursor = 'not-allowed';
      }
      
      listContainer.appendChild(card);
    });
    
  } catch (err) {
    console.error('Error fetching releases:', err);
    listContainer.innerHTML = `
      <div class="releases-error-msg">
        ⚠️ Ошибка загрузки списка версий с GitHub:<br>
        <span style="font-size: 0.85rem; opacity: 0.8;">${err.message}</span>
      </div>
    `;
  }
}

async function installMihomoCore() {
  if (!selectedMihomoRelease) return;
  
  const tag = selectedMihomoRelease.tag_name;
  const downloadUrl = selectedMihomoRelease.download_url;
  
  if (!confirm(`Вы действительно хотите обновить ядро Mihomo до версии ${tag}?`)) {
    return;
  }
  
  closeMihomoUpdateModal();
  showMihomoDimmerOverlay('Установка нового ядра Mihomo и перезапуск службы XKeen...');
  
  try {
    const res = await fetch('/api/mihomo/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tag: tag,
        download_url: downloadUrl
      })
    });
    
    const data = await res.json();
    
    if (res.ok && data.success) {
      showToast(data.message || `Ядро успешно обновлено до ${tag}`, 'success');
      loadMihomoVersion();
    } else {
      showToast(data.error || 'Ошибка при установке ядра', 'error');
    }
  } catch (err) {
    console.error('Error installing core:', err);
    showToast(`Ошибка сети: ${err.message}`, 'error');
  } finally {
    hideMihomoDimmerOverlay();
  }
}

function showMihomoDimmerOverlay(msg) {
  let overlay = document.getElementById('dimmer-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'dimmer-overlay';
    overlay.className = 'dimmer-overlay';
    overlay.innerHTML = '<div class="dimmer-spinner"></div>' +
                        `<div class="dimmer-text">${msg || 'Перезапуск службы XKeen...'}</div>`;
    document.body.appendChild(overlay);
  } else {
    overlay.querySelector('.dimmer-text').textContent = msg || 'Перезапуск службы XKeen...';
  }
  overlay.classList.add('active');
}

function hideMihomoDimmerOverlay() {
  const overlay = document.getElementById('dimmer-overlay');
  if (overlay) {
    overlay.classList.remove('active');
  }
}

async function loadQrConnections() {
  const container = document.getElementById('qr-codes-container');
  if (!container) return;
  container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 40px 0;">⏳ Загрузка параметров подключения...</div>';
  
  try {
    const [wifiRes, providersRes] = await Promise.all([
      fetch('/api/wifi/info'),
      fetch('/api/providers')
    ]);
    
    const wifiData = wifiRes.ok ? await wifiRes.json() : { success: false, ssid: 'Keenetic-WiFi', key: '12345678', encryption: 'WPA' };
    const providersData = providersRes.ok ? await providersRes.json() : { success: true, list: [] };
    
    const wifiString = `WIFI:S:${wifiData.ssid};T:${wifiData.encryption};P:${wifiData.key};;`;
    const baseDomainHttps = 'https://admin:gricha0609@spyware.keenet9883.netcraze.link:8083';
    const baseDomainHttp = 'http://spyware.keenet9883.netcraze.link:4000';
    
    const fullConfigUrlHttps = `${baseDomainHttps}/api/config?file=config_compiled`;
    const fullConfigUrlHttp = `${baseDomainHttp}/api/config?file=config_compiled`;
    
    const noRoutingConfigUrlHttps = `${baseDomainHttps}/api/config?file=config_compiled&routing=false`;
    const noRoutingConfigUrlHttp = `${baseDomainHttp}/api/config?file=config_compiled&routing=false`;
    
    const qrUrlHttpsFull = `${baseDomainHttps}/api/config/mihomo_full.yaml`;
    const qrUrlHttpsLite = `${baseDomainHttps}/api/config/mihomo_lite.yaml`;

    const clashFullUrl = `clash://install-config?url=${encodeURIComponent(qrUrlHttpsFull)}&name=${encodeURIComponent('Mihomo Router Full')}`;
    const clashNoRoutingUrl = `clash://install-config?url=${encodeURIComponent(qrUrlHttpsLite)}&name=${encodeURIComponent('Mihomo Router Lite')}`;
    
    let html = '';
    html += `<div class="qr-cards-grid">`;
    
    // --- 1. КАРТОЧКА WIFI ---
    html += `
      <div class="qr-card">
        <div class="qr-card-header">
          <span class="qr-card-icon">📶</span>
          <span class="qr-card-title">Подключение к Wi-Fi</span>
        </div>
        <div class="qr-code-wrapper">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(wifiString)}" class="qr-image" alt="Wi-Fi QR" />
        </div>
        <div class="qr-card-details">
          <div class="qr-detail-item"><strong>SSID:</strong> <span>${wifiData.ssid}</span> <button class="btn-copy-small" onclick="copyToClipboard('${wifiData.ssid.replace(/'/g, "\\'")}')">📋</button></div>
          <div class="qr-detail-item"><strong>Пароль:</strong> <span>${wifiData.key}</span> <button class="btn-copy-small" onclick="copyToClipboard('${wifiData.key.replace(/'/g, "\\'")}')">📋</button></div>
        </div>
      </div>
    `;
    
    // --- 2. КАРТОЧКА ПОЛНОГО КОНФИГА МИХОМО ---
    html += `
      <div class="qr-card">
        <div class="qr-card-header">
          <span class="qr-card-icon">🚀</span>
          <span class="qr-card-title">Подписка Mihomo (Полная)</span>
        </div>
        <div class="qr-code-wrapper">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(clashFullUrl)}" class="qr-image" alt="Full Config QR" />
        </div>
        <div class="qr-card-details">
          <div class="qr-detail-text">С полной маршрутизацией и встроенными правилами для роутера.</div>
          <div class="qr-detail-text" style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 2px;">HTTPS (с паролем):</div>
          <div class="qr-detail-url" style="margin-bottom: 6px;"><input type="text" readonly value="${fullConfigUrlHttps}" onclick="this.select()" /> <button class="btn-copy-small" onclick="copyToClipboard('${fullConfigUrlHttps}')">📋</button></div>
          <div class="qr-detail-text" style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 2px;">HTTP (без пароля):</div>
          <div class="qr-detail-url"><input type="text" readonly value="${fullConfigUrlHttp}" onclick="this.select()" /> <button class="btn-copy-small" onclick="copyToClipboard('${fullConfigUrlHttp}')">📋</button></div>
        </div>
      </div>
    `;

    // --- 3. КАРТОЧКА КОНФИГА БЕЗ МАРШРУТИЗАЦИИ (ОБНОВЛЯЕМАЯ ПОДПИСКА) ---
    html += `
      <div class="qr-card">
        <div class="qr-card-header">
          <span class="qr-card-icon">🌐</span>
          <span class="qr-card-title">Подписка Mihomo (Без правил)</span>
        </div>
        <div class="qr-code-wrapper">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(clashNoRoutingUrl)}" class="qr-image" alt="No Routing QR" />
        </div>
        <div class="qr-card-details">
          <div class="qr-detail-text">Все ваши VPN-узлы и группы. Идеально для импорта на телефон/ПК без засорения маршрутов.</div>
          <div class="qr-detail-text" style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 2px;">HTTPS (с паролем):</div>
          <div class="qr-detail-url" style="margin-bottom: 6px;"><input type="text" readonly value="${noRoutingConfigUrlHttps}" onclick="this.select()" /> <button class="btn-copy-small" onclick="copyToClipboard('${noRoutingConfigUrlHttps}')">📋</button></div>
          <div class="qr-detail-text" style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 2px;">HTTP (без пароля):</div>
          <div class="qr-detail-url"><input type="text" readonly value="${noRoutingConfigUrlHttp}" onclick="this.select()" /> <button class="btn-copy-small" onclick="copyToClipboard('${noRoutingConfigUrlHttp}')">📋</button></div>
        </div>
      </div>
    `;
    
    // --- 4. КАРТОЧКИ VPN ПОДПИСОК ---
    const providers = providersData.list || [];
    providers.forEach(p => {
      if (p.url) {
        html += `
          <div class="qr-card">
            <div class="qr-card-header">
              <span class="qr-card-icon">📦</span>
              <span class="qr-card-title">Вход подписки: ${p.name}</span>
            </div>
            <div class="qr-code-wrapper">
              <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(p.url)}" class="qr-image" alt="Sub QR" />
            </div>
            <div class="qr-card-details">
              <div class="qr-detail-text">Оригинальная ссылка провайдера VPN.</div>
              <div class="qr-detail-url"><input type="text" readonly value="${p.url}" onclick="this.select()" /> <button class="btn-copy-small" onclick="copyToClipboard('${p.url.replace(/'/g, "\\'")}')">📋</button></div>
            </div>
          </div>
        `;
      }
    });

    // --- 5. ЗАГЛУШКА ЛОКАЛЬНОГО VPN-СЕРВЕРА ---
    html += `
      <div class="qr-card wg-placeholder-card">
        <div class="qr-card-header">
          <span class="qr-card-icon">🛡️</span>
          <span class="qr-card-title">Внешний VPN-сервер роутера</span>
        </div>
        <div class="qr-code-wrapper placeholder-qr">
          <div class="qr-placeholder-overlay">
            <span>ЗАГЛУШКА</span>
          </div>
        </div>
        <div class="qr-card-details">
          <div class="qr-detail-text">Для подключения из внешней сети напрямую к домашнему роутеру.</div>
          <div class="qr-detail-subnet"><strong>Пул IP-адресов:</strong> <code>192.168.2.x</code></div>
          <div class="qr-detail-text" style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">Устройствам будут выделяться адреса 192.168.2.2 - 2.254 для интеграции в локальную сеть с полной маршрутизацией.</div>
        </div>
      </div>
    `;

    html += `</div>`;
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div style="text-align: center; color: var(--danger); padding: 40px 0;">Ошибка загрузки подключений: ${err.message}</div>`;
  }
}
window.loadQrConnections = loadQrConnections;

function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('Скопировано в буфер обмена');
    }).catch(err => {
      fallbackCopyTextToClipboard(text);
    });
  } else {
    fallbackCopyTextToClipboard(text);
  }
}
window.copyToClipboard = copyToClipboard;

function fallbackCopyTextToClipboard(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  
  if (navigator.userAgent.match(/ipad|iphone/i)) {
    textArea.contentEditable = true;
    textArea.readOnly = false;
    const range = document.createRange();
    range.selectNodeContents(textArea);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    textArea.setSelectionRange(0, 999999);
  } else {
    textArea.focus();
    textArea.select();
  }

  try {
    const successful = document.execCommand('copy');
    if (successful) {
      showToast('Скопировано в буфер обмена');
    } else {
      showToast('Не удалось скопировать', 'error');
    }
  } catch (err) {
    showToast('Ошибка при копировании: ' + err.message, 'error');
  }

  document.body.removeChild(textArea);
}

// ============================================================
// ⚡ DPI Tuner, Benchmark & Auto-Heal Controller
// ============================================================

let currentDpiSettings = null;
let currentDpiPresets = [];

async function loadDpiStatus() {
  try {
    const res = await fetch('/api/dpi/status');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.success) {
      currentDpiSettings = data.settings;
      currentDpiPresets = data.presets || [];
      updateDpiSlotsUI(data.settings);
      
      if (data.settings.lastBenchmark && data.settings.lastBenchmark.results) {
        renderDpiBenchmarkTable(data.settings.lastBenchmark.results, data.settings.lastBenchmark.testedAt);
      } else {
        renderDpiDefaultPresetsTable(currentDpiPresets);
      }

      // Настройки Auto-Heal
      if (data.settings.autoHeal) {
        const cb = document.getElementById('dpi-autoheal-enabled');
        const inpInt = document.getElementById('dpi-autoheal-interval');
        const inpThresh = document.getElementById('dpi-autoheal-threshold');
        const logEl = document.getElementById('dpi-autoheal-last-log');
        if (cb) cb.checked = Boolean(data.settings.autoHeal.enabled);
        if (inpInt) inpInt.value = data.settings.autoHeal.intervalHours || 24;
        if (inpThresh) inpThresh.value = data.settings.autoHeal.minSpeedMbps || 8;
        if (logEl && data.settings.autoHeal.lastLog) {
          logEl.textContent = 'Статус: ' + data.settings.autoHeal.lastLog;
        }
      }
    }
  } catch (err) {
    console.error('Ошибка загрузки статуса DPI:', err);
    showToast('Ошибка загрузки настроек DPI: ' + err.message, 'error');
  }
}
window.loadDpiStatus = loadDpiStatus;

function updateDpiSlotsUI(settings) {
  if (!settings || !settings.slots) return;

  ['slot1', 'slot2'].forEach(slotId => {
    const slot = settings.slots[slotId];
    if (!slot) return;

    // Аргументы
    const argsEl = document.getElementById(`dpi-${slotId}-args`);
    if (argsEl) argsEl.textContent = slot.currentArgs || '--split 1+s --disorder 1+s';

    // Замочек
    const lockBtn = document.getElementById(`dpi-${slotId}-lock-btn`);
    if (lockBtn) {
      const isLocked = Boolean(slot.locked);
      lockBtn.classList.toggle('locked', isLocked);
      lockBtn.innerHTML = `
        <span class="lock-icon">${isLocked ? '🔒' : '🔓'}</span>
        <span class="lock-text">${isLocked ? 'Зафиксировано' : 'Авто-ротация'}</span>
      `;
      lockBtn.setAttribute('title', isLocked 
        ? 'Замочек ЗАКРЫТ: Параметры зафиксированы вручную, авто-ротация не меняет эту стратегию' 
        : 'Замочек ОТКРЫТ: Раз в сутки стратегия проверяется и автоматически улучшается при проседании скорости');
    }

    // Телеметрия
    const ytEl = document.getElementById(`dpi-${slotId}-yt-val`);
    const discEl = document.getElementById(`dpi-${slotId}-disc-val`);
    const pingEl = document.getElementById(`dpi-${slotId}-ping-val`);

    if (slot.lastTest) {
      if (ytEl) {
        const speed = slot.lastTest.speedMbps || 0;
        ytEl.innerHTML = `<span class="dpi-badge ${speed >= 50 ? 'dpi-badge-excellent' : (speed >= 15 ? 'dpi-badge-good' : (speed >= 3 ? 'dpi-badge-slow' : 'dpi-badge-failed'))}">${speed} Мбит/с</span>`;
      }
      if (discEl) {
        discEl.innerHTML = slot.lastTest.discordOk ? '<span style="color: #3ddc84;">🟢 OK</span>' : '<span style="color: #ef4444;">🔴 Блок</span>';
      }
      if (pingEl) {
        pingEl.textContent = slot.lastTest.pingMs ? `${slot.lastTest.pingMs} мс` : '-';
      }
    } else {
      if (ytEl) ytEl.textContent = 'Не тестировался';
      if (discEl) discEl.textContent = '-';
      if (pingEl) pingEl.textContent = '-';
    }
  });
}

// Переключение замочка (Lock/Unlock)
async function toggleSlotLockUI(slotId) {
  if (!currentDpiSettings || !currentDpiSettings.slots || !currentDpiSettings.slots[slotId]) return;
  const slot = currentDpiSettings.slots[slotId];
  const nextState = !slot.locked;

  // Оптимистичное обновление UI
  slot.locked = nextState;
  updateDpiSlotsUI(currentDpiSettings);

  try {
    const res = await fetch('/api/dpi/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId, locked: nextState })
    });
    const data = await res.json();
    if (data.success) {
      const slotName = slot.name || slotId;
      if (nextState) {
        showToast(`🔒 ${slotName} зафиксирован: авто-ротация отключена для этого слота`, 'warning');
      } else {
        showToast(`🔓 Авто-ротация для ${slotName} включена! Раз в сутки параметры будут проверяться`, 'success');
      }
    } else {
      throw new Error(data.error || 'Ошибка');
    }
  } catch (err) {
    // Откат при ошибке
    slot.locked = !nextState;
    updateDpiSlotsUI(currentDpiSettings);
    showToast('Ошибка переключения замочка: ' + err.message, 'error');
  }
}
window.toggleSlotLockUI = toggleSlotLockUI;

// Отрисовка дефолтного списка пресетов до запуска бенчмарка
function renderDpiDefaultPresetsTable(presets) {
  const tbody = document.getElementById('dpi-benchmark-tbody');
  if (!tbody) return;

  if (!presets || presets.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 40px 0;">
          Нажмите кнопку «🚀 Запустить бенчмарк», чтобы протестировать все стратегии
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = presets.map(p => `
    <tr class="packet-row">
      <td style="padding: 12px 16px;">
        <div style="font-weight: 600; color: var(--text); font-family: var(--font-outfit);">${p.name}</div>
        <div style="font-size: 0.78rem; color: var(--text-muted);">${p.desc || ''}</div>
      </td>
      <td style="padding: 12px 16px;">
        <code style="background: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 6px; font-size: 0.82rem; color: #a8c7fa;">${p.args}</code>
      </td>
      <td style="padding: 12px 16px; text-align: center; color: var(--text-muted);">
        <span class="dpi-badge" style="background: rgba(255,255,255,0.05); color: var(--text-muted);">Ожидает теста</span>
      </td>
      <td style="padding: 12px 16px; text-align: center; color: var(--text-muted);">-</td>
      <td style="padding: 12px 16px; text-align: center; color: var(--text-muted);">-</td>
      <td style="padding: 12px 16px; text-align: right;">
        <div class="dpi-apply-btn-group">
          <button class="btn-dpi-apply" onclick="applyDpiPreset('slot1', '${p.args.replace(/'/g, "\\'")}', '${p.name.replace(/'/g, "\\'")}')">📺 Для ТВ</button>
          <button class="btn-dpi-apply" onclick="applyDpiPreset('slot2', '${p.args.replace(/'/g, "\\'")}', '${p.name.replace(/'/g, "\\'")}')">📱 Для Смартфонов</button>
        </div>
      </td>
    </tr>
  `).join('');
}

// Отрисовка результатов бенчмарка
function renderDpiBenchmarkTable(results, testedAt) {
  const tbody = document.getElementById('dpi-benchmark-tbody');
  const timeEl = document.getElementById('dpi-last-benchmark-time');
  if (timeEl && testedAt) {
    timeEl.textContent = `Последний тест: ${new Date(testedAt).toLocaleString('ru-RU')}`;
  }
  if (!tbody) return;

  if (!results || results.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--danger); padding: 30px 0;">
          Тест завершился без результатов
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = results.map((r, idx) => {
    const speed = r.speedMbps || 0;
    let badgeClass = 'dpi-badge-failed';
    let badgeText = `${speed} Мбит/с`;
    if (speed >= 60) {
      badgeClass = 'dpi-badge-excellent';
      badgeText = `⭐ ${speed} Мбит/с`;
    } else if (speed >= 20) {
      badgeClass = 'dpi-badge-good';
      badgeText = `🟢 ${speed} Мбит/с`;
    } else if (speed >= 5) {
      badgeClass = 'dpi-badge-slow';
      badgeText = `🟡 ${speed} Мбит/с`;
    } else {
      badgeText = `🔴 ${speed} Мбит/с`;
    }

    const discordBadge = r.discordOk 
      ? '<span style="color: #3ddc84; font-weight: 600;">🟢 OK</span>' 
      : '<span style="color: #ef4444; font-weight: 600;">🔴 Блок</span>';

    const pingText = r.pingMs ? `${r.pingMs} мс` : '-';

    return `
      <tr class="packet-row" style="${idx === 0 && speed >= 20 ? 'background: rgba(61, 220, 132, 0.04);' : ''}">
        <td style="padding: 12px 16px;">
          <div style="font-weight: 600; color: var(--text); font-family: var(--font-outfit); display: flex; align-items: center; gap: 8px;">
            ${r.name || 'Пользовательский пресет'}
            ${idx === 0 && speed >= 20 ? '<span class="dpi-badge dpi-badge-excellent" style="font-size: 0.7rem; padding: 2px 6px;">ТОП-1</span>' : ''}
          </div>
          <div style="font-size: 0.78rem; color: var(--text-muted);">${r.desc || ''}</div>
        </td>
        <td style="padding: 12px 16px;">
          <code style="background: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 6px; font-size: 0.82rem; color: #a8c7fa;">${r.args}</code>
        </td>
        <td style="padding: 12px 16px; text-align: center;">
          <span class="dpi-badge ${badgeClass}">${badgeText}</span>
        </td>
        <td style="padding: 12px 16px; text-align: center;">${discordBadge}</td>
        <td style="padding: 12px 16px; text-align: center; color: var(--text); font-weight: 500;">${pingText}</td>
        <td style="padding: 12px 16px; text-align: right;">
          <div class="dpi-apply-btn-group">
            <button class="btn-dpi-apply" onclick="applyDpiPreset('slot1', '${r.args.replace(/'/g, "\\'")}', '${(r.name || r.args).replace(/'/g, "\\'")}')">📺 Для ТВ</button>
            <button class="btn-dpi-apply" onclick="applyDpiPreset('slot2', '${r.args.replace(/'/g, "\\'")}', '${(r.name || r.args).replace(/'/g, "\\'")}')">📱 Для Смартфонов</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Запуск полного бенчмарка
async function runDpiBenchmark() {
  const btn = document.getElementById('btn-run-dpi-benchmark');
  const progressBox = document.getElementById('dpi-benchmark-progress-container');
  const progressBar = document.getElementById('dpi-progress-bar');
  const progressTitle = document.getElementById('dpi-progress-title');
  const progressCounter = document.getElementById('dpi-progress-counter');

  if (btn) btn.disabled = true;
  if (progressBox) progressBox.style.display = 'block';
  if (progressBar) progressBar.style.width = '10%';
  if (progressTitle) progressTitle.textContent = '🚀 Тестирование стратегий на изолированном порту 10809...';
  if (progressCounter) progressCounter.textContent = 'Запуск...';

  showToast('🚀 Запущен бенчмарк стратегий DPI. Основная сеть работает без прерываний!', 'info');

  let progressInterval = setInterval(() => {
    if (progressBar) {
      let currentWidth = parseFloat(progressBar.style.width) || 10;
      if (currentWidth < 90) {
        progressBar.style.width = (currentWidth + Math.random() * 12) + '%';
      }
    }
  }, 400);

  try {
    const res = await fetch('/api/dpi/benchmark', { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    clearInterval(progressInterval);

    if (progressBar) progressBar.style.width = '100%';

    if (data.success && data.results) {
      renderDpiBenchmarkTable(data.results, data.testedAt);
      showToast(`✅ Бенчмарк завершен! Протестировано ${data.results.length} стратегий.`, 'success');
      loadDpiStatus();
    } else {
      throw new Error(data.error || 'Ошибка теста');
    }
  } catch (err) {
    clearInterval(progressInterval);
    console.error('Ошибка бенчмарка DPI:', err);
    showToast('Ошибка выполнения бенчмарка: ' + err.message, 'error');
  } finally {
    setTimeout(() => {
      if (progressBox) progressBox.style.display = 'none';
      if (btn) btn.disabled = false;
    }, 800);
  }
}
window.runDpiBenchmark = runDpiBenchmark;

// Тестирование пользовательских флагов
async function testCustomDpiArgs() {
  const input = document.getElementById('dpi-custom-args-input');
  const btn = document.getElementById('btn-test-custom-dpi');
  const resultBox = document.getElementById('dpi-custom-result');
  if (!input || !input.value.trim()) {
    showToast('Введите аргументы ByeDPI для теста', 'warning');
    return;
  }

  const args = input.value.trim();
  if (btn) btn.disabled = true;
  if (resultBox) {
    resultBox.style.display = 'block';
    resultBox.innerHTML = '<span class="spinner"></span> Тестируем пресет на порту 10809...';
  }

  try {
    const res = await fetch('/api/dpi/test-custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args })
    });
    const data = await res.json();
    if (data.success && data.result) {
      const r = data.result;
      const speed = r.speedMbps || 0;
      let badgeClass = speed >= 50 ? 'dpi-badge-excellent' : (speed >= 15 ? 'dpi-badge-good' : (speed >= 3 ? 'dpi-badge-slow' : 'dpi-badge-failed'));
      
      resultBox.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div>
            <div style="font-weight: 600; color: var(--text); margin-bottom: 4px;">Результат проверки:</div>
            <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
              <span class="dpi-badge ${badgeClass}">YouTube 4K: ${speed} Мбит/с</span>
              <span style="font-size: 0.85rem;">Discord: ${r.discordOk ? '🟢 OK' : '🔴 Блок'}</span>
              <span style="font-size: 0.85rem; color: var(--text-muted);">Пинг: ${r.pingMs || 0} мс</span>
            </div>
          </div>
          <div class="dpi-apply-btn-group">
            <button class="btn btn-primary" style="font-size: 0.8rem; padding: 6px 12px;" onclick="applyDpiPreset('slot1', '${args.replace(/'/g, "\\'")}', 'Пользовательский пресет')">📺 Применить для ТВ</button>
            <button class="btn btn-primary" style="font-size: 0.8rem; padding: 6px 12px;" onclick="applyDpiPreset('slot2', '${args.replace(/'/g, "\\'")}', 'Пользовательский пресет')">📱 Применить для Смартфонов</button>
          </div>
        </div>
      `;
      showToast('Тестирование пользовательского пресета завершено', 'success');
    } else {
      throw new Error(data.error || 'Ошибка');
    }
  } catch (err) {
    if (resultBox) {
      resultBox.innerHTML = `<span style="color: var(--danger);">Ошибка: ${err.message}</span>`;
    }
    showToast('Ошибка теста: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}
window.testCustomDpiArgs = testCustomDpiArgs;

// Применение пресета к слоту
async function applyDpiPreset(slotId, args, presetName) {
  const slotName = slotId === 'slot1' ? '⚡ ByeDPI 1 (ТВ)' : '⚡ ByeDPI 2 (Смартфон/ПК)';
  try {
    showToast(`Применяем стратегию к ${slotName}...`, 'info');
    const res = await fetch('/api/dpi/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId, args })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ Стратегия успешно применена к ${slotName}! Служба перезапущена.`, 'success');
      loadDpiStatus();
    } else {
      throw new Error(data.error || 'Ошибка применения');
    }
  } catch (err) {
    showToast(`Ошибка применения: ${err.message}`, 'error');
  }
}
window.applyDpiPreset = applyDpiPreset;

// Принудительный запуск фоновой авто-ротации прямо сейчас
async function triggerDpiAutoHealNow() {
  const btn = document.getElementById('btn-run-dpi-autoheal');
  if (btn) btn.disabled = true;
  showToast('⚡ Запуск проверки авто-ротации для открытых слотов 🔓...', 'info');

  try {
    const res = await fetch('/api/dpi/auto-heal/run', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      const results = data.results || [];
      const changed = results.filter(r => r.action === 'auto_healed');
      if (changed.length > 0) {
        showToast(`✅ Авто-ротация обновила ${changed.length} слот(ов) на более быстрые стратегии!`, 'success');
      } else {
        showToast('✅ Проверка завершена: текущие стратегии работают стабильно или зафиксированы 🔒', 'success');
      }
      loadDpiStatus();
    } else {
      throw new Error(data.error || 'Ошибка');
    }
  } catch (err) {
    showToast('Ошибка авто-проверки: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}
window.triggerDpiAutoHealNow = triggerDpiAutoHealNow;

// Выдвижная панель настроек
function toggleDpiSettingsDrawer() {
  const drawer = document.getElementById('dpi-settings-drawer');
  if (drawer) {
    drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
  }
}
window.toggleDpiSettingsDrawer = toggleDpiSettingsDrawer;

// Сохранение настроек авто-ротации
async function saveDpiAutoHealSettings() {
  const cb = document.getElementById('dpi-autoheal-enabled');
  const inpInt = document.getElementById('dpi-autoheal-interval');
  const inpThresh = document.getElementById('dpi-autoheal-threshold');

  const payload = {
    enabled: cb ? cb.checked : true,
    intervalHours: inpInt ? parseInt(inpInt.value) || 24 : 24,
    minSpeedMbps: inpThresh ? parseFloat(inpThresh.value) || 8 : 8
  };

  try {
    const res = await fetch('/api/dpi/auto-heal/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast('Настройки авто-ротации сохранены', 'success');
    }
  } catch (err) {
    showToast('Ошибка сохранения настроек: ' + err.message, 'error');
  }
}
window.saveDpiAutoHealSettings = saveDpiAutoHealSettings;

// ============================================
//   DNS MANAGER & PRESETS
// ============================================

const DNS_PRESETS = {
  adguard: {
    primary: [
      'https://dns.adguard-dns.com/dns-query',
      '94.140.14.14',
      '94.140.15.15'
    ],
    fallback: [
      '94.140.14.14',
      '94.140.15.15'
    ]
  },
  cloudflare: {
    primary: [
      'https://1.1.1.1/dns-query',
      '1.1.1.1',
      '1.0.0.1'
    ],
    fallback: [
      '1.0.0.1',
      '1.1.1.1'
    ]
  },
  quad9: {
    primary: [
      'https://dns.quad9.net/dns-query',
      '9.9.9.9',
      '149.112.112.112'
    ],
    fallback: [
      '149.112.112.112',
      '9.9.9.9'
    ]
  },
  opendns: {
    primary: [
      'https://doh.opendns.com/dns-query',
      '208.67.222.222',
      '208.67.220.220'
    ],
    fallback: [
      '208.67.220.220'
    ]
  },
  google: {
    primary: [
      'https://dns.google/dns-query',
      '8.8.8.8',
      '8.8.4.4'
    ],
    fallback: [
      '8.8.4.4',
      '8.8.8.8'
    ]
  },
  yandex: {
    primary: [
      '77.88.8.8',
      '77.88.8.1'
    ],
    fallback: [
      '77.88.8.8',
      '77.88.8.1'
    ]
  },
  local: {
    primary: [
      '127.0.0.1'
    ],
    fallback: [
      '127.0.0.1'
    ]
  }
};

let currentDnsData = null;

async function loadDnsSettings() {
  try {
    const res = await fetch('/api/dns');
    if (!res.ok) {
      if (res.status === 404) {
        showToast('Эндпоинт /api/dns не найден на запущенном сервере (404). Пожалуйста, перезапустите службу контроллера!', 'error');
        return;
      }
      const errText = await res.text();
      showToast(`Ошибка сервера (${res.status}): ${errText}`, 'error');
      return;
    }
    const data = await res.json();
    if (data.success && data.dns) {
      currentDnsData = data.dns;
      renderDnsSettings(data.dns);
    } else {
      showToast('Ошибка загрузки настроек DNS: ' + (data.message || data.error || 'Неизвестная ошибка'), 'error');
    }
  } catch (err) {
    console.error('Ошибка загрузки DNS:', err);
    showToast('Сбой связи с сервером при получении DNS: ' + err.message, 'error');
  }
}
window.loadDnsSettings = loadDnsSettings;

function renderDnsSettings(dns) {
  // Primary nameservers
  const primaryArea = document.getElementById('dns-primary-textarea');
  if (primaryArea) {
    primaryArea.value = (dns.nameserver || []).join('\n');
    updateDnsPrimaryCountBadge();
    syncDnsPresetButtons(false);

    if (!primaryArea.dataset.dnsInputBound) {
      primaryArea.dataset.dnsInputBound = 'true';
      primaryArea.addEventListener('input', () => {
        updateDnsPrimaryCountBadge();
        syncDnsPresetButtons(false);
      });
    }
  }

  // Fallback section
  const fallbackToggle = document.getElementById('dns-fallback-toggle');
  const fallbackArea = document.getElementById('dns-fallback-textarea');
  const fallbackContainer = document.getElementById('dns-fallback-container');
  const fallbackBadge = document.getElementById('dns-fallback-status-badge');
  const isFallbackEnabled = dns.fallback_enabled || (dns.fallback && dns.fallback.length > 0);

  if (fallbackToggle) {
    fallbackToggle.checked = !!isFallbackEnabled;
  }
  if (fallbackArea) {
    fallbackArea.value = (dns.fallback || []).join('\n');
    syncDnsPresetButtons(true);

    if (!fallbackArea.dataset.dnsInputBound) {
      fallbackArea.dataset.dnsInputBound = 'true';
      fallbackArea.addEventListener('input', () => {
        syncDnsPresetButtons(true);
      });
    }
  }
  if (fallbackContainer) {
    fallbackContainer.style.display = isFallbackEnabled ? 'block' : 'none';
  }
  if (fallbackBadge) {
    fallbackBadge.textContent = isFallbackEnabled ? `Включен (${(dns.fallback || []).length} серверов)` : 'Отключен';
    fallbackBadge.style.color = isFallbackEnabled ? '#3ddc84' : 'var(--text-muted)';
    fallbackBadge.style.borderColor = isFallbackEnabled ? 'rgba(61, 220, 132, 0.4)' : 'var(--border-color)';
  }

  // Fallback filter
  const geoipCb = document.getElementById('dns-fallback-geoip');
  const geoipCode = document.getElementById('dns-fallback-geoip-code');
  if (geoipCb) geoipCb.checked = dns.fallback_filter_geoip !== false;
  if (geoipCode) geoipCode.value = dns.fallback_filter_geoip_code || 'RU';

  // Advanced core settings
  const modeSelect = document.getElementById('dns-enhanced-mode');
  const listenInput = document.getElementById('dns-listen-address');
  const ipv6Cb = document.getElementById('dns-ipv6-toggle');
  const activeBadge = document.getElementById('dns-active-status-badge');

  if (modeSelect) modeSelect.value = dns.enhanced_mode || 'redir-host';
  if (listenInput) listenInput.value = dns.listen || '127.0.0.1:1053';
  if (ipv6Cb) ipv6Cb.checked = !!dns.ipv6;
  if (activeBadge) activeBadge.textContent = `Режим: ${dns.enhanced_mode || 'redir-host'}`;
}

function updateDnsPrimaryCountBadge() {
  const primaryArea = document.getElementById('dns-primary-textarea');
  const badge = document.getElementById('dns-primary-count-badge');
  if (!primaryArea || !badge) return;
  const lines = primaryArea.value.split('\n').map(l => l.trim()).filter(Boolean);
  badge.textContent = `${lines.length} ${getNounDns(lines.length, 'сервер', 'сервера', 'серверов')}`;
}

function getNounDns(number, one, two, five) {
  let n = Math.abs(number);
  n %= 100;
  if (n >= 5 && n <= 20) return five;
  n %= 10;
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return two;
  return five;
}

function toggleFallbackSection() {
  const toggle = document.getElementById('dns-fallback-toggle');
  const container = document.getElementById('dns-fallback-container');
  const badge = document.getElementById('dns-fallback-status-badge');
  const isEnabled = toggle && toggle.checked;

  if (container) {
    container.style.display = isEnabled ? 'block' : 'none';
  }
  if (badge) {
    badge.textContent = isEnabled ? 'Включен' : 'Отключен';
    badge.style.color = isEnabled ? '#3ddc84' : 'var(--text-muted)';
    badge.style.borderColor = isEnabled ? 'rgba(61, 220, 132, 0.4)' : 'var(--border-color)';
  }
}
window.toggleFallbackSection = toggleFallbackSection;

function syncDnsPresetButtons(isFallback = false) {
  const targetArea = document.getElementById(isFallback ? 'dns-fallback-textarea' : 'dns-primary-textarea');
  if (!targetArea) return;

  const currentLines = targetArea.value
    .split('\n')
    .map(l => l.trim().toLowerCase())
    .filter(Boolean);

  const container = isFallback
    ? document.querySelector('#dns-fallback-container .dns-presets-container')
    : document.querySelector('#tab-content-dns .dns-presets-container');

  if (!container) return;

  let matchedPresetKey = null;
  const buttons = container.querySelectorAll('.dns-preset-btn');

  // Check which predefined preset matches the textarea
  for (const [key, val] of Object.entries(DNS_PRESETS)) {
    const presetServers = (isFallback ? val.fallback : val.primary)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    const isMatch = currentLines.length > 0 &&
      currentLines.length === presetServers.length &&
      presetServers.every((s, idx) => currentLines[idx] === s);

    if (isMatch) {
      matchedPresetKey = key;
      break;
    }
  }

  // If no predefined preset matches, highlight 'custom'
  if (!matchedPresetKey) {
    matchedPresetKey = 'custom';
  }

  buttons.forEach(btn => {
    const presetKey = btn.getAttribute('data-preset');
    if (presetKey === matchedPresetKey) {
      btn.classList.add('active-preset');
    } else {
      btn.classList.remove('active-preset');
    }
  });
}
window.syncDnsPresetButtons = syncDnsPresetButtons;

function applyDnsPreset(presetKey, isFallback = false) {
  const targetArea = document.getElementById(isFallback ? 'dns-fallback-textarea' : 'dns-primary-textarea');
  if (!targetArea) return;

  if (isFallback) {
    const toggle = document.getElementById('dns-fallback-toggle');
    if (toggle && !toggle.checked) {
      toggle.checked = true;
      toggleFallbackSection();
    }
  }

  if (presetKey === 'custom') {
    targetArea.value = '';
    if (!isFallback) {
      updateDnsPrimaryCountBadge();
    }
    syncDnsPresetButtons(isFallback);
    targetArea.focus();
    showToast(`Поле очищено. Введите свои адреса для ${isFallback ? 'Fallback' : 'Primary'} DNS`, 'info');
    return;
  }

  const preset = DNS_PRESETS[presetKey];
  if (!preset) return;

  const servers = isFallback ? preset.fallback : preset.primary;
  targetArea.value = servers.join('\n');

  if (!isFallback) {
    updateDnsPrimaryCountBadge();
  }

  syncDnsPresetButtons(isFallback);
  showToast(`Применен пресет ${presetKey.toUpperCase()} для ${isFallback ? 'Fallback' : 'Primary'} DNS!`, 'success');
}
window.applyDnsPreset = applyDnsPreset;

function applyRecommendedDnsPreset() {
  applyDnsPreset('adguard', false);
  applyDnsPreset('yandex', true);
  showToast('Установлен рекомендуемый пресет: AdGuard DoH (Primary) + Yandex DNS (Fallback)', 'success');
}
window.applyRecommendedDnsPreset = applyRecommendedDnsPreset;

function clearDnsPrimary() {
  const primaryArea = document.getElementById('dns-primary-textarea');
  if (primaryArea) {
    primaryArea.value = '';
    updateDnsPrimaryCountBadge();
    syncDnsPresetButtons(false);
  }
}
window.clearDnsPrimary = clearDnsPrimary;

async function saveDnsSettings() {
  const saveBtn = document.getElementById('btn-save-dns');
  const primaryArea = document.getElementById('dns-primary-textarea');
  const fallbackArea = document.getElementById('dns-fallback-textarea');
  const fallbackToggle = document.getElementById('dns-fallback-toggle');
  const geoipCb = document.getElementById('dns-fallback-geoip');
  const geoipCode = document.getElementById('dns-fallback-geoip-code');
  const modeSelect = document.getElementById('dns-enhanced-mode');
  const listenInput = document.getElementById('dns-listen-address');
  const ipv6Cb = document.getElementById('dns-ipv6-toggle');

  const nameservers = (primaryArea ? primaryArea.value : '').split('\n').map(l => l.trim()).filter(Boolean);
  if (nameservers.length === 0) {
    showToast('Укажите хотя бы один основной DNS сервер!', 'error');
    if (primaryArea) primaryArea.focus();
    return;
  }

  const fallbackEnabled = fallbackToggle ? fallbackToggle.checked : false;
  const fallbacks = (fallbackArea ? fallbackArea.value : '').split('\n').map(l => l.trim()).filter(Boolean);

  const payload = {
    enable: true,
    ipv6: ipv6Cb ? ipv6Cb.checked : false,
    enhanced_mode: modeSelect ? modeSelect.value : 'redir-host',
    listen: listenInput ? listenInput.value.trim() : '127.0.0.1:1053',
    nameserver: nameservers,
    fallback_enabled: fallbackEnabled,
    fallback: fallbacks,
    fallback_filter_geoip: geoipCb ? geoipCb.checked : true,
    fallback_filter_geoip_code: geoipCode ? (geoipCode.value.trim().toUpperCase() || 'RU') : 'RU'
  };

  const oldBtnHtml = saveBtn ? saveBtn.innerHTML : '';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span>⏳ Применение в ядре...</span>';
  }

  try {
    const res = await fetch('/api/dns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const errText = await res.text();
      showToast(`Ошибка сервера (${res.status}): ${errText}`, 'error');
      return;
    }
    const data = await res.json();
    if (data.success) {
      showToast('✓ Настройки DNS успешно сохранены и применены в Mihomo!', 'success');
      loadDnsSettings();
    } else {
      showToast('Ошибка: ' + (data.message || data.error || 'Не удалось применить DNS'), 'error');
    }
  } catch (err) {
    console.error('Ошибка сохранения DNS:', err);
    showToast('Сбой отправки запроса сохранения DNS: ' + err.message, 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = oldBtnHtml;
    }
  }
}
window.saveDnsSettings = saveDnsSettings;

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'dns-primary-textarea') {
    updateDnsPrimaryCountBadge();
  }
});



