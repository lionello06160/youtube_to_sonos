const DEFAULT_URL = 'http://10.10.4.14:3005';

const statusPill = document.getElementById('statusPill');
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const nowPlaying = document.getElementById('nowPlaying');
const serverUrl = document.getElementById('serverUrl');
const deviceList = document.getElementById('deviceList');
const toast = document.getElementById('toast');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressElapsed = document.getElementById('progressElapsed');
const progressDuration = document.getElementById('progressDuration');

const scanBtn = document.getElementById('scanBtn');
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');
const selectAllBtn = document.getElementById('selectAllBtn');
const clearBtn = document.getElementById('clearBtn');
const youtubeUrl = document.getElementById('youtubeUrl');
const openOptions = document.getElementById('openOptions');

let apiUrl = DEFAULT_URL;
let devices = [];
let selectedHosts = [];
let lastStatus = null;
let saveUrlTimer = null;

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
};

const updateProgress = (data) => {
  if (!progressBar) return;

  if (!data || !data.isPlaying) {
    progressBar.classList.remove('is-indeterminate');
    progressBar.style.width = '0%';
    progressElapsed.textContent = '0:00';
    progressDuration.textContent = '--:--';
    return;
  }

  if (!data.startedAt || !data.durationSec) {
    progressBar.classList.add('is-indeterminate');
    progressBar.style.width = '';
    progressElapsed.textContent = '--:--';
    progressDuration.textContent = data.durationLabel || '--:--';
    return;
  }

  progressBar.classList.remove('is-indeterminate');
  const elapsed = Math.max(0, Math.min(data.durationSec, (Date.now() - data.startedAt) / 1000));
  const percent = Math.min(100, (elapsed / data.durationSec) * 100);
  progressBar.style.width = `${percent}%`;
  progressElapsed.textContent = formatTime(elapsed);
  progressDuration.textContent = data.durationLabel || formatTime(data.durationSec);
};

const showToast = (message) => {
  toast.textContent = message;
  toast.hidden = false;
  setTimeout(() => {
    toast.hidden = true;
  }, 2500);
};

const request = async (path, options) => {
  const res = await fetch(`${apiUrl}${path}`, options);
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res;
};

const loadSettings = async () => {
  const { apiUrl: stored, lastYoutubeUrl } = await chrome.storage.sync.get({
    apiUrl: DEFAULT_URL,
    lastYoutubeUrl: ''
  });
  apiUrl = stored || DEFAULT_URL;
  serverUrl.textContent = `Server: ${apiUrl}`;
  if (lastYoutubeUrl && !youtubeUrl.value) {
    youtubeUrl.value = lastYoutubeUrl;
  }
};

const saveLastUrl = (value) => {
  if (saveUrlTimer) clearTimeout(saveUrlTimer);
  saveUrlTimer = setTimeout(() => {
    chrome.storage.sync.set({ lastYoutubeUrl: value.trim() });
  }, 300);
};

const renderDevices = () => {
  if (!devices.length) {
    deviceList.innerHTML = '<div class="empty">No devices</div>';
    return;
  }
  deviceList.innerHTML = '';
  devices.forEach((device) => {
    const isSelected = selectedHosts.includes(device.host);
    const card = document.createElement('div');
    card.className = `device ${isSelected ? 'selected' : ''}`;
    card.innerHTML = `
      <div class="device-title">
        <span>${device.name}</span>
        <span>${isSelected ? '✓' : ''}</span>
      </div>
      <div class="device-meta">${device.model} · ${device.host}</div>
      <div class="volume">
        <span class="volume-value">${device.volume}%</span>
        <input type="range" min="0" max="100" value="${device.volume}" />
      </div>
    `;

    card.addEventListener('click', () => {
      if (selectedHosts.includes(device.host)) {
        selectedHosts = selectedHosts.filter((h) => h !== device.host);
      } else {
        selectedHosts = [...selectedHosts, device.host];
      }
      renderDevices();
    });

    const slider = card.querySelector('input');
    const volumeValue = card.querySelector('.volume-value');
    slider.addEventListener('click', (e) => e.stopPropagation());
    slider.addEventListener('input', async (e) => {
      const value = Number(e.target.value);
      device.volume = value;
      if (volumeValue) {
        volumeValue.textContent = `${value}%`;
      }
      try {
        await request('/volume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: device.host, volume: value })
        });
      } catch {
        showToast('Volume update failed');
      }
    });

    deviceList.appendChild(card);
  });
};

const fetchDevices = async () => {
  try {
    const res = await request('/scan');
    devices = await res.json();
    selectedHosts = devices.map((d) => d.host);
    renderDevices();
  } catch (err) {
    showToast('Scan failed');
  }
};

const fetchStatus = async () => {
  try {
    const res = await request('/status');
    const data = await res.json();
    lastStatus = data;
    statusText.textContent = data.isPlaying ? 'LIVE' : 'IDLE';
    statusPill.style.background = data.isPlaying ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.08)';
    statusDot.classList.toggle('live', Boolean(data.isPlaying));
    nowPlaying.textContent = data.title ? `Now: ${data.title}` : 'Now: -';
    updateProgress(data);
  } catch {
    statusText.textContent = 'OFFLINE';
    nowPlaying.textContent = 'Now: -';
    statusDot.classList.remove('live');
    lastStatus = null;
    updateProgress(null);
  }
};

const play = async () => {
  if (!youtubeUrl.value || !selectedHosts.length) return;
  try {
    if (selectedHosts.length > 1) {
      await request('/group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ masterHost: selectedHosts[0], memberHosts: selectedHosts })
      });
    }
    await request('/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceHost: selectedHosts[0], youtubeUrl: youtubeUrl.value })
    });
    saveLastUrl(youtubeUrl.value);
    showToast('Broadcast started');
    fetchStatus();
  } catch {
    showToast('Playback failed');
  }
};

const stop = async () => {
  if (!selectedHosts.length) return;
  try {
    await request('/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceHost: selectedHosts[0] })
    });
    showToast('Stopped');
    fetchStatus();
  } catch {
    showToast('Stop failed');
  }
};

scanBtn.addEventListener('click', fetchDevices);
playBtn.addEventListener('click', play);
stopBtn.addEventListener('click', stop);
youtubeUrl.addEventListener('input', () => saveLastUrl(youtubeUrl.value));
selectAllBtn.addEventListener('click', () => {
  selectedHosts = devices.map((d) => d.host);
  renderDevices();
});
clearBtn.addEventListener('click', () => {
  selectedHosts = [];
  renderDevices();
});
openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

(async () => {
  await loadSettings();
  await fetchDevices();
  await fetchStatus();
  setInterval(fetchStatus, 5000);
  setInterval(() => {
    if (lastStatus) {
      updateProgress(lastStatus);
    }
  }, 1000);
})();
