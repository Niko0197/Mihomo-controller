// system_stats.js
// Модуль сбора метрик роутера (ЦП, ОЗУ, Температура процессора)

const fs = require('fs');

let currentCpuLoad = 0;
let prevCpuStats = null;

// Запуск фонового тикера нагрузки процессора (каждую 1 секунду)
function startCpuTicker() {
  setInterval(() => {
    try {
      if (!fs.existsSync('/proc/stat')) return;
      const statText = fs.readFileSync('/proc/stat', 'utf8');
      const firstLine = statText.split('\n')[0];
      
      if (!firstLine.startsWith('cpu ')) return;
      
      const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
      const user = parts[0] || 0;
      const nice = parts[1] || 0;
      const system = parts[2] || 0;
      const idle = parts[3] || 0;
      const iowait = parts[4] || 0;
      const irq = parts[5] || 0;
      const softirq = parts[6] || 0;
      const steal = parts[7] || 0;
      
      const totalIdle = idle + iowait;
      const totalActive = user + nice + system + irq + softirq + steal;
      const total = totalIdle + totalActive;
      
      if (prevCpuStats) {
        const deltaIdle = totalIdle - prevCpuStats.totalIdle;
        const deltaTotal = total - prevCpuStats.total;
        
        if (deltaTotal > 0) {
          const load = Math.round(100 * (1 - deltaIdle / deltaTotal));
          currentCpuLoad = Math.max(0, Math.min(100, load));
        }
      }
      
      prevCpuStats = { totalIdle, total };
    } catch (err) {
      console.error('Ошибка расчета нагрузки ЦП:', err.message);
    }
  }, 1000);
}

// Запуск тикера при загрузке модуля
startCpuTicker();

// Получение системных метрик
function getSystemStats() {
  let ramUsedPercent = 0;
  let ramUsedMb = 0;
  let ramTotalMb = 0;
  let temp = 0;

  // 1. Чтение оперативной памяти
  try {
    if (fs.existsSync('/proc/meminfo')) {
      const memText = fs.readFileSync('/proc/meminfo', 'utf8');
      const lines = memText.split('\n');
      
      let memTotalKb = 0;
      let memAvailableKb = 0;
      let memFreeKb = 0;
      let buffersKb = 0;
      let cachedKb = 0;

      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const key = parts[0];
          const val = parseInt(parts[1], 10);
          if (key === 'MemTotal:') memTotalKb = val;
          if (key === 'MemAvailable:') memAvailableKb = val;
          if (key === 'MemFree:') memFreeKb = val;
          if (key === 'Buffers:') buffersKb = val;
          if (key === 'Cached:') cachedKb = val;
        }
      });

      if (memTotalKb > 0) {
        // Если MemAvailable нет, вычисляем примерный объем свободной памяти
        const freeKb = memAvailableKb || (memFreeKb + buffersKb + cachedKb);
        const usedKb = memTotalKb - freeKb;
        
        ramTotalMb = Math.round(memTotalKb / 1024);
        ramUsedMb = Math.round(usedKb / 1024);
        ramUsedPercent = Math.round((usedKb / memTotalKb) * 100);
      }
    }
  } catch (err) {
    console.error('Ошибка чтения ОЗУ:', err.message);
  }

  // 2. Чтение температуры процессора
  try {
    const tempPath = '/sys/class/thermal/thermal_zone0/temp';
    if (fs.existsSync(tempPath)) {
      const rawTemp = fs.readFileSync(tempPath, 'utf8').trim();
      const numTemp = parseInt(rawTemp, 10);
      if (!isNaN(numTemp)) {
        temp = parseFloat((numTemp / 1000).toFixed(1));
      }
    }
  } catch (err) {
    console.error('Ошибка чтения температуры:', err.message);
  }

  return {
    cpu: currentCpuLoad,
    ramUsedPercent,
    ramUsedMb,
    ramTotalMb,
    temp
  };
}

module.exports = {
  getSystemStats
};
