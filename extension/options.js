const DEFAULT_URL = 'http://10.10.4.14:3005';
const apiUrlInput = document.getElementById('apiUrl');
const saveBtn = document.getElementById('saveBtn');
const testBtn = document.getElementById('testBtn');
const status = document.getElementById('status');

const showStatus = (message, ok = true) => {
  status.textContent = message;
  status.style.color = ok ? '#a7f3d0' : '#fca5a5';
};

const load = async () => {
  const { apiUrl } = await chrome.storage.sync.get({ apiUrl: DEFAULT_URL });
  apiUrlInput.value = apiUrl || DEFAULT_URL;
};

saveBtn.addEventListener('click', async () => {
  const value = apiUrlInput.value.trim() || DEFAULT_URL;
  await chrome.storage.sync.set({ apiUrl: value });
  showStatus('Saved.');
});

testBtn.addEventListener('click', async () => {
  try {
    const url = apiUrlInput.value.trim() || DEFAULT_URL;
    const res = await fetch(`${url}/check`);
    if (!res.ok) throw new Error('bad');
    showStatus('Server reachable.');
  } catch {
    showStatus('Cannot reach server.', false);
  }
});

load();
