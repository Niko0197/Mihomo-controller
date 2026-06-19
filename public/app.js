let leakedDomains = [];
let proxyGroups = [];
let subGroups = [];
let proxiesList = [];
let torData = null;
let configEditor = null; // Инстанс CodeMirror
let currentConfigFileId = 'config';
let configFiles = [];

// Показ уведомлений
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Переключение вкладок
function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  
  document.getElementById('tab-content-' + tabId).classList.add('active');
  document.getElementById('tab-btn-' + tabId).classList.add('active');
  
  if (tabId === 'tor') {
    loadTorBridges();
  } else if (tabId === 'editor') {
    loadConfigFilesList();
    loadConfigEditor();
    setTimeout(() => {
      if (configEditor) configEditor.refresh();
    }, 50);
  } else if (tabId === 'import') {
    loadImportGroups();
  } else if (tabId === 'subs') {
    loadSubscriptions();
  } else if (tabId === 'ping') {
    loadProxiesList();
  } else if (tabId === 'rules') {
    loadDynamicRulesTab();
  } else if (tabId === 'updates') {
    loadVersionsList();
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
async function loadSubscriptions() {
  const tbody = document.getElementById('subs-list');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Загрузка списка подписок...</td></tr>';
  
  try {
    const res = await fetch('/api/providers');
    if (!res.ok) throw new Error('Ошибка загрузки провайдеров');
    const payload = await res.json();
    const list = payload.list || [];
    subGroups = payload.groups || [];
    
    tbody.innerHTML = '';
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">Нет настроенных подписок</td></tr>';
      return;
    }
    
    list.forEach(sub => {
      const tr = document.createElement('tr');
      
      const tdName = document.createElement('td');
      tdName.style.fontWeight = '600';
      tdName.textContent = sub.name;
      
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
          const r = await resUpdate.json();
          if (!resUpdate.ok || !r.success) throw new Error(r.message || 'Ошибка сети');
          showToast(`Подписка ${sub.name} успешно обновлена в памяти!`);
          loadSubscriptions();
        } catch (err) {
          showToast(err.message, 'error');
          btnUpdate.disabled = false;
          btnUpdate.textContent = '🔄 Обновить';
        }
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
      tdActions.appendChild(btnEdit);
      tdActions.appendChild(btnDel);
      
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
    if (g === '⚙️Manual 1' || g === '⚙️Manual 2') chk.checked = true;
    
    label.appendChild(chk);
    label.appendChild(document.createTextNode(g));
    container.appendChild(label);
  });

  if (sub) {
    title.textContent = 'Редактировать подписку: ' + sub.name;
    nameInput.value = sub.name;
    nameInput.disabled = true;
    urlInput.value = sub.url;
    intervalInput.value = sub.interval;
    oldNameInput.value = sub.name;
    groupsSection.style.display = 'none';
  } else {
    title.textContent = 'Добавить новую подписку';
    nameInput.value = '';
    nameInput.disabled = false;
    urlInput.value = '';
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
  const interval = parseInt(document.getElementById('sub-interval').value.trim(), 10);
  const oldName = document.getElementById('edit-sub-old-name').value;
  const btn = document.getElementById('btn-save-sub');
  
  if (!name || !url || isNaN(interval)) {
    showToast('Пожалуйста, заполните все поля корректно!', 'error');
    return;
  }
  
  btn.disabled = true;
  btn.textContent = 'Сохранение...';
  
  const isEdit = oldName.length > 0;
  const apiEndpoint = isEdit ? '/api/providers/edit' : '/api/providers/add';
  
  const payload = { name, url, interval };
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

// === СКАЧИВАНИЕ TOR-МОСТОВ ===
async function loadTorBridges(force = false) {
  const textarea = document.getElementById('tor-bridges-textarea');
  const updateBtn = document.getElementById('btn-tor-force-update');
  const countSpan = document.getElementById('tor-last-update');
  
  if (torData && !force) {
    renderTorBridges();
    return;
  }
  
  if (force) {
    updateBtn.disabled = true;
    updateBtn.textContent = 'Обновление...';
    textarea.value = 'Загрузка свежих мостов напрямую из GitHub репозитория...';
  }
  
  try {
    const url = force ? '/api/tor-bridges/update' : '/api/tor-bridges';
    const method = force ? 'POST' : 'GET';
    const fetchUrl = force ? url : url + '?t=' + Date.now();
    
    const res = await fetch(fetchUrl, { method });
    if (!res.ok) throw new Error('Сбой сети при запросе мостов');
    const data = await res.json();
    
    if (data.success) {
      torData = data.bridges;
      
      try {
        localStorage.setItem('mc_tor_bridges', JSON.stringify({
          lastUpdated: data.lastUpdated,
          bridges: data.bridges
        }));
      } catch (e) {}
      
      renderTorBridges();
      if (force) showToast('Мосты успешно обновлены с GitHub!');
    } else {
      throw new Error(data.error || 'Неизвестная ошибка сервера');
    }
  } catch (err) {
    if (!force && torData) {
      renderTorBridges();
      showToast('Кэшированные мосты (ошибка авто-обновления: ' + err.message + ')', 'error');
    } else {
      textarea.value = `Ошибка загрузки мостов: ${err.message}\n\nПопробуйте нажать кнопку "Обновить с GitHub" для принудительного скачивания.`;
      countSpan.textContent = 'Ошибка загрузки';
    }
  } finally {
    updateBtn.disabled = false;
    updateBtn.textContent = '🔄 Обновить с GitHub';
  }
}

// Отрисовка выбранного типа мостов
function renderTorBridges() {
  const type = document.getElementById('tor-bridge-type').value;
  const textarea = document.getElementById('tor-bridges-textarea');
  const countSpan = document.getElementById('tor-last-update');
  
  if (!torData || !torData[type]) {
    textarea.value = 'Нет доступных мостов для выбранного типа. Нажмите "Обновить с GitHub".';
    return;
  }
  
  textarea.value = torData[type].trim();
  
  try {
    const cachedBridges = localStorage.getItem('mc_tor_bridges');
    if (cachedBridges) {
      const parsed = JSON.parse(cachedBridges);
      const lastUpdatedDate = new Date(parsed.lastUpdated);
      countSpan.textContent = `Обновлено: ${lastUpdatedDate.toLocaleString('ru-RU')}`;
    }
  } catch (e) {}
}

// Копирование в буфер
document.getElementById('btn-tor-copy').onclick = function() {
  const textarea = document.getElementById('tor-bridges-textarea');
  if (!textarea.value || textarea.value.startsWith('Ошибка') || textarea.value.startsWith('Загрузка') || textarea.value.startsWith('Нет доступных')) {
    showToast('Нечего копировать!', 'error');
    return;
  }
  
  const textToCopy = textarea.value;
  
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(textToCopy).then(() => {
      showToast('Все мосты скопированы в буфер обмена!');
    }).catch(err => {
      fallbackCopyToClipboard(textToCopy);
    });
  } else {
    fallbackCopyToClipboard(textToCopy);
  }
};

function fallbackCopyToClipboard(text) {
  const tempTextarea = document.createElement('textarea');
  tempTextarea.value = text;
  tempTextarea.style.position = 'fixed';
  tempTextarea.style.left = '-999999px';
  tempTextarea.style.top = '-999999px';
  document.body.appendChild(tempTextarea);
  tempTextarea.select();
  
  try {
    const successful = document.execCommand('copy');
    document.body.removeChild(tempTextarea);
    if (successful) {
      showToast('Все мосты скопированы в буфер обмена!');
    } else {
      showToast('Не удалось скопировать мосты', 'error');
    }
  } catch (err) {
    document.body.removeChild(tempTextarea);
    showToast('Ошибка копирования: ' + err.message, 'error');
  }
}

// Принудительное обновление мостов
document.getElementById('btn-tor-force-update').onclick = function() {
  loadTorBridges(true);
};

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
  loadData();
  loadPanelVersion();
  updateXkeenStatus();
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
        branchVal.textContent = data.branch;
        if (data.branch.toLowerCase() === 'main' || data.branch.toLowerCase() === 'master') {
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
  const dependentTabs = ['proxies-dashboard', 'ping', 'traffic', 'connections', 'logs', 'trace'];
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

  filtered.forEach(r => {
    const tr = document.createElement('tr');
    if (!r.dynamic) {
      tr.style.opacity = '0.7';
    }

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
      deleteBtn.onclick = () => deleteDynamicRule(r);
      tdAction.appendChild(deleteBtn);
    } else {
      const lockSpan = document.createElement('span');
      lockSpan.style.color = 'var(--text-muted)';
      lockSpan.style.fontSize = '0.9rem';
      lockSpan.title = 'Системное правило (только чтение)';
      lockSpan.textContent = '🔒';
      tdAction.appendChild(lockSpan);
    }

    tr.appendChild(tdType);
    tr.appendChild(tdValue);
    tr.appendChild(tdTarget);
    tr.appendChild(tdAction);

    tbody.appendChild(tr);
  });
  initCustomSelects();
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
    wrapper.classList.add(selectEl.className + '-container');
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
    
    // Close other custom selects first
    document.querySelectorAll('.custom-select-wrapper').forEach(w => {
      if (w !== wrapper) w.classList.remove('open');
    });
    
    wrapper.classList.toggle('open');
    
    // If opening, ensure the active option is scrolled into view
    if (wrapper.classList.contains('open')) {
      const selected = dropdown.querySelector('.custom-select-option.selected');
      if (selected) {
        dropdown.scrollTop = selected.offsetTop - dropdown.offsetTop - 10;
      }
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

// Global click listener to close dropdowns when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.custom-select-wrapper').forEach(wrapper => {
    wrapper.classList.remove('open');
  });
});

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

    // ДЕДУБЛИКАЦИЯ: Если есть одинаковые версии, оставляем только коммит ветки main
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
        uniqueCommits.push(commitsList[0]);
      } else {
        // Ищем коммит, где ветка - main или master
        const mainCommit = commitsList.find(c => c.branch === 'main' || c.branch === 'master');
        if (mainCommit) {
          // Если хотя бы один из дубликатов был текущим (активным), помечаем как текущий именно main-коммит
          const hasCurrent = commitsList.some(c => c.current);
          if (hasCurrent) {
            mainCommit.current = true;
          }
          uniqueCommits.push(mainCommit);
        } else {
          // Если нет коммита из main, оставляем самый первый (новейший)
          uniqueCommits.push(commitsList[0]);
        }
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

