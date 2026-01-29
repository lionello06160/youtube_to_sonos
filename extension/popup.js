const DEFAULT_URL = 'http://10.10.4.213:3005';

const statusPill = document.getElementById('statusPill');
const nowPlaying = document.getElementById('nowPlaying');
const serverUrl = document.getElementById('serverUrl');
const deviceList = document.getElementById('deviceList');
const toast = document.getElementById('toast');

const scanBtn = document.getElementById('scanBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const selectAllBtn = document.getElementById('selectAllBtn');
const clearBtn = document.getElementById('clearBtn');
const youtubeUrl = document.getElementById('youtubeUrl');
const openOptions = document.getElementById('openOptions');

let apiUrl = DEFAULT_URL;
let devices = [];
let selectedHosts = [];

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
  const { apiUrl: stored } = await chrome.storage.sync.get({ apiUrl: DEFAULT_URL });
  apiUrl = stored || DEFAULT_URL;
  serverUrl.textContent = `Server: ${apiUrl}`;
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
        <span>${device.volume}%</span>
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
    slider.addEventListener('click', (e) => e.stopPropagation());
    slider.addEventListener('input', async (e) => {
      const value = Number(e.target.value);
      device.volume = value;
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
    renderDevices();
  } catch (err) {
    showToast('Scan failed');
  }
};

const fetchStatus = async () => {
  try {
    const res = await request('/status');
    const data = await res.json();
    statusPill.textContent = data.isPlaying ? 'LIVE' : 'IDLE';
    statusPill.style.background = data.isPlaying ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.08)';
    nowPlaying.textContent = data.title ? `Now: ${data.title}` : 'Now: -';
  } catch {
    statusPill.textContent = 'OFFLINE';
    nowPlaying.textContent = 'Now: -';
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
    showToast('Broadcast started');
    fetchStatus();
  } catch {
    showToast('Playback failed');
  }
};

const pause = async () => {
  if (!selectedHosts.length) return;
  try {
    await request('/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceHost: selectedHosts[0] })
    });
    showToast('Paused');
    fetchStatus();
  } catch {
    showToast('Pause failed');
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
pauseBtn.addEventListener('click', pause);
stopBtn.addEventListener('click', stop);
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
})();
