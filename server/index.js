const express = require('express');
const { Sonos, AsyncDeviceDiscovery } = require('sonos');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const util = require('util');
const fs = require('fs');
const path = require('path');
const execPromise = util.promisify(exec);

const app = express();
const PORT = 3005;
const HOST_IP = '10.10.4.14';
const VERSION = '8.0 (Clean URI)';
const PLAYLIST_PATH = path.join(__dirname, 'playlist.json');
const DEFAULT_LOOP_MODE = 'all';
const YT_COOKIES = process.env.YT_COOKIES || '';
const YT_JS_RUNTIME = process.env.YT_JS_RUNTIME || '';
const YT_EXTRACTOR_ARGS = process.env.YT_EXTRACTOR_ARGS || 'youtube:player_client=android';
const YT_USER_AGENT = process.env.YT_USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const YT_FORCE_IPV4 = String(process.env.YT_FORCE_IPV4 || 'true').toLowerCase() !== 'false';

// STORE STATE LOCALLY
// This allows us to give Sonos a clean URL without messy query params
let currentYoutubeUrl = '';
let currentTitle = 'Sonons Stream';
let currentDurationSec = null;
let currentDurationLabel = null;
let lastPlayback = null;
let restartTimer = null;
let restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_WINDOW_MS = 20000;
let currentDirectUrl = '';
let currentDirectUrlAt = 0;
const DIRECT_URL_TTL_MS = 5 * 60 * 1000;
let activeStreamCount = 0;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DAILY_STOP_HOUR = 17;
const DAILY_STOP_MINUTE = 0;
let dailyStopTimer = null;
let dailyStartTimer = null;
let autoConfig = {
    autoPlayUrl: '',
    autoPlayDeviceHost: '',
    autoPlayTime: '',
    autoStopTime: '',
    autoShutdownTime: '',
    autoPlayOnBoot: false
};
let playlistItems = [];
let playlistCurrentIndex = null;
let playlistCurrentUid = null;
let playlistMode = false;
let loopMode = DEFAULT_LOOP_MODE;
let shuffleOrder = [];
let shufflePos = 0;
let playlistAdvanceLock = false;

const parseTime = (value) => {
    if (!value || typeof value !== 'string') return null;
    const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
};
const formatTimeParts = (hour, minute) =>
    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
const getEffectiveStopTime = () => {
    const parsed = parseTime(autoConfig.autoStopTime);
    if (parsed) return formatTimeParts(parsed.hour, parsed.minute);
    return formatTimeParts(DAILY_STOP_HOUR, DAILY_STOP_MINUTE);
};

const formatDuration = (seconds) => {
    if (!Number.isFinite(seconds)) return null;
    const total = Math.max(0, Math.floor(seconds));
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hrs > 0) {
        return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
};

const readJsonFile = (filePath) => {
    if (!fs.existsSync(filePath)) return null;
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        console.warn(`[WARN] Failed to read ${path.basename(filePath)}: ${err.message}`);
        return null;
    }
};

const writeJsonFile = (filePath, data) => {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
        console.warn(`[WARN] Failed to write ${path.basename(filePath)}: ${err.message}`);
    }
};

const shuffleArray = (arr) => {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
};

const buildShuffleOrder = (startUid) => {
    const allUids = playlistItems.map((item) => item.uid);
    if (!allUids.length) return [];
    if (!startUid) return shuffleArray(allUids);
    const rest = allUids.filter((uid) => uid !== startUid);
    return [startUid, ...shuffleArray(rest)];
};

const persistPlaylistState = () => {
    writeJsonFile(PLAYLIST_PATH, {
        items: playlistItems,
        loopMode,
        currentUid: playlistCurrentUid,
        currentIndex: playlistCurrentIndex
    });
};

const loadPlaylistState = () => {
    const stored = readJsonFile(PLAYLIST_PATH);
    if (!stored) return;
    if (Array.isArray(stored.items)) {
        playlistItems = stored.items.map((item) => ({
            ...item,
            uid: item.uid || crypto.randomUUID()
        }));
    }
    if (stored.loopMode && ['all', 'single', 'shuffle'].includes(stored.loopMode)) {
        loopMode = stored.loopMode;
    }
    if (stored.currentUid) {
        playlistCurrentUid = stored.currentUid;
        const index = playlistItems.findIndex((item) => item.uid === playlistCurrentUid);
        playlistCurrentIndex = index >= 0 ? index : null;
    } else if (Number.isInteger(stored.currentIndex)) {
        playlistCurrentIndex = stored.currentIndex;
        playlistCurrentUid = playlistItems[playlistCurrentIndex]?.uid || null;
    }
    if (loopMode === 'shuffle' && playlistItems.length) {
        shuffleOrder = buildShuffleOrder(playlistCurrentUid || playlistItems[0].uid);
        shufflePos = 0;
    }
};

const loadAutoConfig = () => {
    const envConfig = {
        autoPlayUrl: process.env.AUTO_PLAY_URL || '',
        autoPlayDeviceHost: process.env.AUTO_PLAY_DEVICE_HOST || '',
        autoPlayTime: process.env.AUTO_PLAY_TIME || '',
        autoStopTime: process.env.AUTO_STOP_TIME || '',
        autoShutdownTime: process.env.AUTO_SHUTDOWN_TIME || '',
        autoPlayOnBoot: String(process.env.AUTO_PLAY_ON_BOOT || '').toLowerCase() === 'true'
    };
    if (!fs.existsSync(CONFIG_PATH)) {
        autoConfig = envConfig;
        return;
    }
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        autoConfig = { ...envConfig, ...parsed };
    } catch (err) {
        log(`[WARN] Failed to read config.json: ${err.message}`);
        autoConfig = envConfig;
    }
};

const logs = [];
const log = (msg) => {
    const line = `[v${VERSION}] ${new Date().toLocaleTimeString()} | ${msg}`;
    console.log(line);
    logs.push(line);
    if (logs.length > 100) logs.shift();
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isEpipe = (err) =>
    !!err && (err.code === 'EPIPE' || String(err.message || '').includes('EPIPE'));
const isRetryableUpnp = (err) => {
    const msg = String(err?.message || err || '');
    return /ClientUPnPError1023|statusCode\s*500|upnp|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(msg);
};
const withRetry = async (fn, { label, attempts = 3, baseDelay = 300 } = {}) => {
    let lastErr;
    for (let i = 0; i < attempts; i += 1) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const retryable = isRetryableUpnp(err);
            if (!retryable || i === attempts - 1) {
                throw err;
            }
            log(`[WARN] ${label || 'UPnP'} failed, retrying (${i + 1}/${attempts}): ${err.message}`);
            await sleep(baseDelay * (i + 1));
        }
    }
    throw lastErr;
};
const scheduleRestart = (reason) => {
    if (!lastPlayback) return;
    const age = Date.now() - lastPlayback.startedAt;
    if (age > RESTART_WINDOW_MS) {
        log(`- Restart skipped (too old): ${reason}`);
        return;
    }
    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
        log(`- Restart skipped (max attempts): ${reason}`);
        return;
    }
    if (restartTimer) return;
    restartAttempts += 1;
    const delay = 1500 * restartAttempts;
    log(`- Auto-restart scheduled in ${delay}ms (${reason})`);
    restartTimer = setTimeout(async () => {
        restartTimer = null;
        try {
            const device = new Sonos(lastPlayback.deviceHost);
            log(`- Auto-restart attempt ${restartAttempts}`);
            await withRetry(
                () => device.setAVTransportURI({ uri: lastPlayback.uri, metadata: lastPlayback.metadata, onlySetUri: true }),
                { label: 'Auto-restart setAVTransportURI', attempts: 3, baseDelay: 400 }
            );
            await withRetry(() => device.play(), { label: 'Auto-restart play', attempts: 3, baseDelay: 400 });
        } catch (err) {
            log(`[WARN] Auto-restart failed: ${err.message}`);
        }
    }, delay);
};

const scheduleDailyStop = () => {
    if (dailyStopTimer) clearTimeout(dailyStopTimer);
    const stopTime = parseTime(autoConfig.autoStopTime) || {
        hour: DAILY_STOP_HOUR,
        minute: DAILY_STOP_MINUTE
    };
    const now = new Date();
    const next = new Date(now);
    next.setHours(stopTime.hour, stopTime.minute, 0, 0);
    if (next <= now) {
        next.setDate(next.getDate() + 1);
    }
    const delay = next.getTime() - now.getTime();
    log(`Daily stop scheduled for ${next.toLocaleString()}`);
    dailyStopTimer = setTimeout(async () => {
        try {
            if (lastPlayback?.deviceHost) {
                const device = new Sonos(lastPlayback.deviceHost);
                await device.stop();
                log('Daily stop: playback stopped.');
            }
        } catch (err) {
            log(`[WARN] Daily stop failed: ${err.message}`);
        } finally {
            currentYoutubeUrl = '';
            currentDirectUrl = '';
            currentDirectUrlAt = 0;
            currentDurationSec = null;
            currentDurationLabel = null;
            scheduleDailyStop();
        }
    }, delay);
};

const scheduleDailyStart = () => {
    if (dailyStartTimer) clearTimeout(dailyStartTimer);
    const startTime = parseTime(autoConfig.autoPlayTime);
    if (!startTime || !autoConfig.autoPlayUrl || !autoConfig.autoPlayDeviceHost) {
        log('Daily start not scheduled (missing autoPlayTime/autoPlayUrl/autoPlayDeviceHost).');
        return;
    }
    const now = new Date();
    const next = new Date(now);
    next.setHours(startTime.hour, startTime.minute, 0, 0);
    if (next <= now) {
        next.setDate(next.getDate() + 1);
    }
    const delay = next.getTime() - now.getTime();
    log(`Daily start scheduled for ${next.toLocaleString()}`);
    dailyStartTimer = setTimeout(async () => {
        try {
            await startPlayback(autoConfig.autoPlayDeviceHost, autoConfig.autoPlayUrl);
            log('Daily start: playback started.');
        } catch (err) {
            log(`[WARN] Daily start failed: ${err.message}`);
        } finally {
            scheduleDailyStart();
        }
    }, delay);
};

const resolveDirectUrl = async (youtubeUrl, ytExtractorArgs, ytUserAgent) => {
    const now = Date.now();
    if (currentDirectUrl && now - currentDirectUrlAt < DIRECT_URL_TTL_MS) {
        return currentDirectUrl;
    }
    const { stdout } = await execPromise(
        `yt-dlp --no-warnings --no-playlist --extractor-args "${ytExtractorArgs}" --user-agent "${ytUserAgent}" -f "bestaudio/best" -g "${youtubeUrl}"`,
        { maxBuffer: 1024 * 1024 }
    );
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) {
        throw new Error('yt-dlp returned empty direct URL');
    }
    currentDirectUrl = lines[0];
    currentDirectUrlAt = now;
    return currentDirectUrl;
};

const buildTrackFromEntry = (entry = {}) => {
    const rawId = entry.id || entry.url || '';
    const id = String(rawId).trim();
    if (!id) return null;
    const url =
        typeof entry.url === 'string' && /^https?:/i.test(entry.url)
            ? entry.url
            : `https://www.youtube.com/watch?v=${id}`;
    const durationSec = Number.isFinite(entry.duration) ? Number(entry.duration) : null;
    const durationLabel = entry.duration_string || (durationSec ? formatDuration(durationSec) : null);
    return {
        uid: crypto.randomUUID(),
        id,
        url,
        title: String(entry.title || 'Unknown').trim() || 'Unknown',
        durationSec,
        durationLabel
    };
};

const resolvePlaylistTracks = async (inputUrl) => {
    const { stdout } = await execPromise(
        `yt-dlp --no-warnings --flat-playlist --dump-single-json "${inputUrl}"`,
        { maxBuffer: 1024 * 1024 * 2 }
    );
    const payload = JSON.parse(stdout);
    const entries = Array.isArray(payload?.entries) ? payload.entries : [payload];
    return entries.map(buildTrackFromEntry).filter(Boolean);
};

const resetShuffleOrder = (startUid) => {
    if (!playlistItems.length) {
        shuffleOrder = [];
        shufflePos = 0;
        return;
    }
    shuffleOrder = buildShuffleOrder(startUid || playlistCurrentUid || playlistItems[0].uid);
    shufflePos = 0;
};

const getNextUidByShuffle = () => {
    if (!playlistItems.length) return null;
    if (!shuffleOrder.length) {
        resetShuffleOrder(playlistCurrentUid || playlistItems[0].uid);
    }
    let nextPos = shufflePos + 1;
    if (nextPos >= shuffleOrder.length) {
        resetShuffleOrder(playlistCurrentUid || shuffleOrder[shuffleOrder.length - 1]);
        nextPos = 0;
    }
    shufflePos = nextPos;
    return shuffleOrder[shufflePos] || null;
};

const advancePlaylist = async (deviceHost) => {
    if (playlistAdvanceLock) return;
    if (!playlistMode || !playlistItems.length) return;
    if (!deviceHost) return;
    playlistAdvanceLock = true;
    try {
        let nextIndex = playlistCurrentIndex ?? 0;
        let nextUid = playlistCurrentUid;

        if (loopMode === 'single') {
            // Keep same index/uid
        } else if (loopMode === 'shuffle') {
            nextUid = getNextUidByShuffle();
            nextIndex = playlistItems.findIndex((item) => item.uid === nextUid);
        } else {
            nextIndex = (nextIndex + 1) % playlistItems.length;
            nextUid = playlistItems[nextIndex]?.uid || null;
        }

        if (nextIndex == null || nextIndex < 0) return;
        const nextTrack = playlistItems[nextIndex];
        if (!nextTrack) return;

        playlistCurrentIndex = nextIndex;
        playlistCurrentUid = nextTrack.uid;
        persistPlaylistState();

        await startPlayback(deviceHost, nextTrack.url);
    } catch (err) {
        log(`[WARN] Playlist advance failed: ${err.message}`);
    } finally {
        playlistAdvanceLock = false;
    }
};

log(`BOOT: Starting Sonons v${VERSION}...`);
loadAutoConfig();
loadPlaylistState();
if (YT_COOKIES) {
    log(`YT cookies enabled: ${YT_COOKIES}`);
}
if (YT_JS_RUNTIME) {
    log(`YT JS runtime: ${YT_JS_RUNTIME}`);
}
log(`YT extractor args: ${YT_EXTRACTOR_ARGS}`);
if (YT_FORCE_IPV4) {
    log('YT force IPv4 enabled');
}
scheduleDailyStop();
scheduleDailyStart();
if (autoConfig.autoPlayOnBoot && autoConfig.autoPlayUrl && autoConfig.autoPlayDeviceHost) {
    setTimeout(async () => {
        try {
            await startPlayback(autoConfig.autoPlayDeviceHost, autoConfig.autoPlayUrl);
            log('Auto play on boot started.');
        } catch (err) {
            log(`[WARN] Auto play on boot failed: ${err.message}`);
        }
    }, 8000);
}

const resolveCoordinatorHost = async (deviceHost) => {
    try {
        const device = new Sonos(deviceHost);
        const groups = await device.getAllGroups();
        for (const group of groups) {
            const members = Array.isArray(group.ZoneGroupMember) ? group.ZoneGroupMember : [group.ZoneGroupMember];
            for (const member of members) {
                if (!member || !member.Location) continue;
                try {
                    const host = new URL(member.Location).hostname;
                    if (host === deviceHost) {
                        return group.host || deviceHost;
                    }
                } catch (err) {
                    continue;
                }
            }
        }
    } catch (err) {
        log(`[WARN] Coordinator lookup failed: ${err.message}`);
    }
    return deviceHost;
};

const getZoneNameByHost = async (deviceHost) => {
    const device = new Sonos(deviceHost);
    try {
        const attrs = await device.getZoneAttrs();
        return attrs.CurrentZoneName || 'Sonos';
    } catch (err) {
        return 'Sonos';
    }
};

const escapeXml = (value = '') =>
    String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const normalizeTitle = (value = '') =>
    String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
const toAscii = (value = '') =>
    String(value).replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
const truncate = (value, max = 120) => {
    if (!value || value.length <= max) return value;
    if (max <= 3) return value.slice(0, max);
    return value.slice(0, max - 3) + '...';
};

const normalizeYoutubeUrl = (input = '') => {
    const value = String(input || '').trim();
    if (!value) return value;
    try {
        const url = new URL(value);
        let id = '';
        if (url.hostname.includes('youtu.be')) {
            id = url.pathname.replace(/^\/+/, '').split('/')[0] || '';
        } else if (url.pathname.startsWith('/shorts/')) {
            id = url.pathname.split('/')[2] || '';
        } else {
            id = url.searchParams.get('v') || '';
        }
        if (id) {
            return `https://www.youtube.com/watch?v=${id}`;
        }
    } catch (err) {
        // fallthrough
    }
    return value;
};

const resetPlaybackState = () => {
    currentYoutubeUrl = '';
    currentTitle = 'Sonons Stream';
    currentDurationSec = null;
    currentDurationLabel = null;
    currentDirectUrl = '';
    currentDirectUrlAt = 0;
    activeStreamCount = 0;
    restartAttempts = 0;
    lastPlayback = null;
};

app.use(cors());
app.use(express.json());

// Logger
app.use((req, res, next) => {
    log(`[REQ] ${req.method} ${req.url}`);
    next();
});

app.get('/check', (req, res) => res.send(`<h1>Sonons v${VERSION} is ALIVE</h1>`));
app.get('/logs', (req, res) => res.send(`<pre>${logs.join('\n')}</pre>`));

// Discovery
app.get('/devices', async (req, res) => {
    const discovery = new AsyncDeviceDiscovery();
    try {
        const devices = await discovery.discoverMultiple({ timeout: 4000 });
        const detailedDevices = await Promise.all(devices.map(async (d) => {
            try {
                const device = new Sonos(d.host);
                const [zoneAttrs, volume] = await Promise.all([
                    device.getZoneAttrs().catch(() => ({ CurrentZoneName: 'Unknown' })),
                    device.getVolume().catch(() => 50)
                ]);
                return { host: d.host, name: zoneAttrs.CurrentZoneName, model: d.model || 'Sonos', volume };
            } catch (e) { return null; }
        }));
        res.json(detailedDevices.filter(d => d !== null));
    } catch (e) { res.json([]); }
});

app.get('/scan', async (req, res) => {
    const net = require('net');
    const foundHosts = [];
    const scanPromises = [];
    for (const b of [4, 5, 6, 7]) {
        for (let i = 1; i <= 254; i++) {
            const host = `10.10.${b}.${i}`;
            scanPromises.push(new Promise((resolve) => {
                const socket = new net.Socket();
                socket.setTimeout(80);
                socket.on('connect', () => { foundHosts.push(host); socket.destroy(); resolve(); });
                socket.on('timeout', () => { socket.destroy(); resolve(); });
                socket.on('error', () => { socket.destroy(); resolve(); });
                socket.connect(1400, host);
            }));
        }
    }
    await Promise.all(scanPromises);
    const detailedDevices = await Promise.all(foundHosts.map(async (host) => {
        try {
            const device = new Sonos(host);
            const [zoneAttrs, volume] = await Promise.all([
                device.getZoneAttrs(),
                device.getVolume()
            ]);
            return { host, name: zoneAttrs.CurrentZoneName, model: 'Sonos', volume };
        } catch (e) { return null; }
    }));
    res.json(detailedDevices.filter(d => d !== null));
});

// Playlist
app.get('/playlist', (req, res) => {
    res.json({
        items: playlistItems,
        currentIndex: playlistCurrentIndex,
        loopMode
    });
});

app.post('/playlist', async (req, res) => {
    const { inputUrl, mode = 'append' } = req.body || {};
    if (!inputUrl) {
        res.status(400).send('inputUrl required');
        return;
    }
    try {
        const tracks = await resolvePlaylistTracks(inputUrl);
        if (mode === 'replace') {
            playlistItems = tracks;
            playlistCurrentIndex = null;
            playlistCurrentUid = null;
            playlistMode = false;
        } else {
            playlistItems = [...playlistItems, ...tracks];
        }
        if (loopMode === 'shuffle') {
            resetShuffleOrder(playlistCurrentUid || playlistItems[0]?.uid);
        }
        persistPlaylistState();
        res.send({ items: playlistItems, addedCount: tracks.length });
    } catch (err) {
        log(`[ERR] Playlist load: ${err.message}`);
        res.status(500).send(err.message);
    }
});

app.post('/playlist/reorder', (req, res) => {
    const { order } = req.body || {};
    if (!Array.isArray(order)) {
        res.status(400).send('order must be an array');
        return;
    }
    const byUid = new Map(playlistItems.map((item) => [item.uid, item]));
    const ordered = order.map((uid) => byUid.get(uid)).filter(Boolean);
    const missing = playlistItems.filter((item) => !order.includes(item.uid));
    playlistItems = [...ordered, ...missing];
    if (playlistCurrentUid) {
        const idx = playlistItems.findIndex((item) => item.uid === playlistCurrentUid);
        playlistCurrentIndex = idx >= 0 ? idx : null;
    }
    if (loopMode === 'shuffle') {
        resetShuffleOrder(playlistCurrentUid || playlistItems[0]?.uid);
    }
    persistPlaylistState();
    res.send({ items: playlistItems });
});

app.post('/playlist/remove', async (req, res) => {
    const { uid } = req.body || {};
    if (!uid) {
        res.status(400).send('uid required');
        return;
    }
    const indexToRemove = playlistItems.findIndex((item) => item.uid === uid);
    if (indexToRemove < 0) {
        res.status(404).send('track not found');
        return;
    }

    const removingCurrent = playlistCurrentUid === uid;
    playlistItems = playlistItems.filter((item) => item.uid !== uid);

    if (!playlistItems.length) {
        playlistCurrentIndex = null;
        playlistCurrentUid = null;
        playlistMode = false;
        shuffleOrder = [];
        shufflePos = 0;
        persistPlaylistState();
        if (removingCurrent && lastPlayback?.deviceHost) {
            try {
                const device = new Sonos(lastPlayback.deviceHost);
                await withRetry(() => device.stop(), { label: 'Stop after remove', attempts: 2, baseDelay: 300 });
            } catch (err) {
                log(`[WARN] Stop after remove failed: ${err.message}`);
            }
            resetPlaybackState();
        }
        res.send({ items: playlistItems, currentIndex: playlistCurrentIndex });
        return;
    }

    if (removingCurrent) {
        let nextIndex = indexToRemove;
        if (nextIndex >= playlistItems.length) {
            nextIndex = 0;
        }
        const nextTrack = playlistItems[nextIndex];
        playlistCurrentIndex = nextIndex;
        playlistCurrentUid = nextTrack.uid;
        if (loopMode === 'shuffle') {
            resetShuffleOrder(nextTrack.uid);
        }
        persistPlaylistState();
        if (playlistMode && lastPlayback?.deviceHost) {
            try {
                await startPlayback(lastPlayback.deviceHost, nextTrack.url);
            } catch (err) {
                log(`[WARN] Auto-play after remove failed: ${err.message}`);
            }
        }
    } else {
        if (playlistCurrentIndex != null && indexToRemove < playlistCurrentIndex) {
            playlistCurrentIndex -= 1;
        }
        if (playlistCurrentUid) {
            const idx = playlistItems.findIndex((item) => item.uid === playlistCurrentUid);
            playlistCurrentIndex = idx >= 0 ? idx : null;
        }
        if (loopMode === 'shuffle') {
            resetShuffleOrder(playlistCurrentUid || playlistItems[0]?.uid);
        }
        persistPlaylistState();
    }

    res.send({ items: playlistItems, currentIndex: playlistCurrentIndex });
});

app.post('/playlist/start', async (req, res) => {
    const { deviceHost, index } = req.body || {};
    if (!deviceHost || !Number.isInteger(index)) {
        res.status(400).send('deviceHost and index required');
        return;
    }
    const track = playlistItems[index];
    if (!track) {
        res.status(404).send('track not found');
        return;
    }
    playlistMode = true;
    playlistCurrentIndex = index;
    playlistCurrentUid = track.uid;
    if (loopMode === 'shuffle') {
        resetShuffleOrder(track.uid);
    }
    persistPlaylistState();
    try {
        const { title } = await startPlayback(deviceHost, track.url);
        res.send({ status: 'playing', title, index });
    } catch (err) {
        log(`[ERR] Playlist start: ${err.message}`);
        res.status(500).send(err.message);
    }
});

app.post('/playlist/mode', (req, res) => {
    const { loopMode: nextMode } = req.body || {};
    if (!['all', 'single', 'shuffle'].includes(nextMode)) {
        res.status(400).send('invalid loopMode');
        return;
    }
    loopMode = nextMode;
    if (loopMode === 'shuffle') {
        resetShuffleOrder(playlistCurrentUid || playlistItems[0]?.uid);
    } else {
        shuffleOrder = [];
        shufflePos = 0;
    }
    persistPlaylistState();
    res.send({ status: 'ok', loopMode });
});

app.post('/playlist/clear', (req, res) => {
    playlistItems = [];
    playlistCurrentIndex = null;
    playlistCurrentUid = null;
    playlistMode = false;
    shuffleOrder = [];
    shufflePos = 0;
    persistPlaylistState();
    res.send({ status: 'ok' });
});

// Group devices (optional)
app.post('/group', async (req, res) => {
    const { masterHost, memberHosts = [] } = req.body || {};
    if (!masterHost) {
        res.status(400).send('masterHost required');
        return;
    }
    try {
        const masterName = await getZoneNameByHost(masterHost);
        const masterDevice = new Sonos(masterHost);
        try {
            await withRetry(() => masterDevice.becomeCoordinatorOfStandaloneGroup(), {
                label: 'Master leave group',
                attempts: 3,
                baseDelay: 400
            });
        } catch (err) {
            log(`[WARN] Master leave group failed: ${err.message}`);
        }

        const members = memberHosts.filter((host) => host && host !== masterHost);
        for (const host of members) {
            try {
                const memberDevice = new Sonos(host);
                await withRetry(() => memberDevice.joinGroup(masterName), {
                    label: `Join group ${host}`,
                    attempts: 3,
                    baseDelay: 400
                });
                log(`- Joined ${host} -> ${masterName}`);
            } catch (err) {
                log(`[WARN] Join failed for ${host}: ${err.message}`);
            }
        }
        res.send({ status: 'ok', masterHost, masterName, joined: members.length });
    } catch (err) {
        log(`[ERR] Group: ${err.message}`);
        res.status(500).send(err.message);
    }
});

const startPlayback = async (deviceHost, youtubeUrl) => {
    const normalizedUrl = normalizeYoutubeUrl(youtubeUrl);
    if (normalizedUrl !== youtubeUrl) {
        log(`- Normalized URL: ${normalizedUrl}`);
    }
    log(`SETUP CLEAN PLAY: ${normalizedUrl} on ${deviceHost}`);

    // 1. UPDATE STATE
    currentYoutubeUrl = normalizedUrl;
    currentDirectUrl = '';
    currentDirectUrlAt = 0;

    const coordinatorHost = await resolveCoordinatorHost(deviceHost);
    if (coordinatorHost !== deviceHost) {
        log(`- Coordinator resolved: ${deviceHost} -> ${coordinatorHost}`);
    }
    const device = new Sonos(coordinatorHost);
    try {
        await withRetry(() => device.stop(), { label: 'Preflight stop', attempts: 2, baseDelay: 300 });
    } catch (err) {
        log(`[WARN] Preflight stop failed: ${err.message}`);
    }
    const cookieFlag = YT_COOKIES ? ` --cookies "${YT_COOKIES}"` : '';
    const jsRuntimeFlag = YT_JS_RUNTIME ? ` --js-runtimes "${YT_JS_RUNTIME}"` : '';
    const ipv4Flag = YT_FORCE_IPV4 ? ' -4' : '';
    const { stdout } = await execPromise(
        `yt-dlp --no-config --no-warnings --no-playlist${cookieFlag}${jsRuntimeFlag}${ipv4Flag} --extractor-args "${YT_EXTRACTOR_ARGS}" --user-agent "${YT_USER_AGENT}" --print "%(title)s" --print "%(thumbnail)s" --print "%(duration)s" --print "%(duration_string)s" "${normalizedUrl}"`,
        { maxBuffer: 1024 * 1024 }
    );
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const title = lines[0] || 'Sonons Audio';
    const art = lines[1] || '';
    const durationSec = Number(lines[2]);
    const durationLabel = lines[3] || null;

    currentTitle = title;
    currentDurationSec = Number.isFinite(durationSec) ? durationSec : null;
    currentDurationLabel = durationLabel;
    const normalizedTitle = truncate(normalizeTitle(title), 120);
    const asciiTitle = truncate(toAscii(title) || 'Sonons Stream', 120);
    const safeTitle = escapeXml(normalizedTitle);
    const safeAsciiTitle = escapeXml(asciiTitle);

    // 2. CLEAN URI - No query params, looks like a static file
    // We use x-rincon-mp3radio for best "Stream" compatibility
    const streamHost = `${HOST_IP}:${PORT}`;
    const streamPath = `${streamHost}/sonons.mp3`;
    const uriMp3Radio = `x-rincon-mp3radio://${streamPath}`;
    const uriHttp = `http://${streamPath}`;

    log(`- Title: ${title}`);
    log(`- Primary URI: ${uriMp3Radio}`);

    // 3. MINIMAL METADATA
    // Sometimes less is more. We use a generic radio metadata block.
    const buildMetadata = (titleValue) =>
        `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="-1" parentID="-1" restricted="1"><dc:title>${titleValue}</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON65031_</desc></item></DIDL-Lite>`;

    const candidates = [
        { label: 'x-rincon-mp3radio + meta', uri: uriMp3Radio, metadata: buildMetadata(safeTitle) },
        { label: 'x-rincon-mp3radio + ascii-meta', uri: uriMp3Radio, metadata: buildMetadata(safeAsciiTitle) },
        { label: 'x-rincon-mp3radio + empty', uri: uriMp3Radio, metadata: '' },
        { label: 'http + meta', uri: uriHttp, metadata: buildMetadata(safeTitle) },
        { label: 'http + ascii-meta', uri: uriHttp, metadata: buildMetadata(safeAsciiTitle) },
        { label: 'http + empty', uri: uriHttp, metadata: '' }
    ];

    let lastError;
    for (const option of candidates) {
        try {
            log(`- Trying AVTransport: ${option.label}`);
            await withRetry(
                () => device.setAVTransportURI({ uri: option.uri, metadata: option.metadata, onlySetUri: true }),
                { label: `Set AVTransport (${option.label})`, attempts: 3, baseDelay: 400 }
            );
            log(`- Starting playback...`);
            await withRetry(() => device.play(), { label: 'Play', attempts: 3, baseDelay: 400 });
            log(`[SUCCESS] Device accepted: ${option.label}`);
            lastPlayback = {
                deviceHost: coordinatorHost,
                uri: option.uri,
                metadata: option.metadata,
                startedAt: Date.now()
            };
            restartAttempts = 0;
            if (restartTimer) {
                clearTimeout(restartTimer);
                restartTimer = null;
            }
            return { title, art };
        } catch (err) {
            lastError = err;
            log(`- Failed: ${option.label} -> ${err.message}`);
        }
    }

    throw lastError || new Error('All AVTransport candidates failed');
};

// Play (YouTube)
app.post('/play', async (req, res) => {
    const { deviceHost, youtubeUrl } = req.body;
    try {
        playlistMode = false;
        const { title } = await startPlayback(deviceHost, youtubeUrl);
        res.send({ status: 'playing', title });
    } catch (e) {
        log(`[FATAL] Play Error: ${e.message}`);
        res.status(500).send(e.message);
    }
});

// Volume
app.post('/volume', async (req, res) => {
    const { host, volume } = req.body;
    try {
        const device = new Sonos(host);
        await device.setVolume(volume);
        res.send({ status: 'ok' });
    } catch (e) {
        log(`[ERR] Volume: ${e.message}`);
        res.status(500).send(e.message);
    }
});

// Pause/Stop
app.post('/pause', async (req, res) => {
    const { deviceHost } = req.body;
    if (!deviceHost) {
        res.status(400).send('deviceHost required');
        return;
    }
    try {
        const host = await resolveCoordinatorHost(deviceHost);
        const device = new Sonos(host);
        await withRetry(() => device.pause(), { label: 'Pause', attempts: 2, baseDelay: 300 });
        playlistMode = false;
        restartAttempts = 0;
        lastPlayback = null;
        res.send({ status: 'paused' });
    } catch (e) {
        log(`[ERR] Pause: ${e.message}`);
        res.status(500).send(e.message);
    }
});

app.post('/stop', async (req, res) => {
    const { deviceHost } = req.body;
    if (!deviceHost) {
        res.status(400).send('deviceHost required');
        return;
    }
    try {
        const host = await resolveCoordinatorHost(deviceHost);
        const device = new Sonos(host);
        await withRetry(() => device.stop(), { label: 'Stop', attempts: 2, baseDelay: 300 });
        playlistMode = false;
        resetPlaybackState();
        res.send({ status: 'stopped' });
    } catch (e) {
        log(`[ERR] Stop: ${e.message}`);
        res.status(500).send(e.message);
    }
});

// Status
app.get('/status', (req, res) => {
    res.json({
        title: currentTitle || null,
        youtubeUrl: currentYoutubeUrl || null,
        isPlaying: !!currentYoutubeUrl && activeStreamCount > 0,
        activeStreams: activeStreamCount,
        startedAt: lastPlayback?.startedAt || null,
        deviceHost: lastPlayback?.deviceHost || null,
        durationSec: currentDurationSec,
        durationLabel: currentDurationLabel,
        autoStopTime: getEffectiveStopTime(),
        autoShutdownTime: autoConfig.autoShutdownTime || null,
        playlistCount: playlistItems.length,
        playlistIndex: playlistCurrentIndex,
        playlistMode,
        loopMode
    });
});

// THE CLEAN ENDPOINT
app.get('/sonons.mp3', async (req, res) => {
    log(`SPEAKER CONNECTED to /sonons.mp3`);

    if (!currentYoutubeUrl) {
        log('No active URL set, closing connection.');
        res.end();
        return;
    }

    activeStreamCount += 1;
    let closed = false;
    let endedNaturally = false;
    const markClosed = () => {
        if (closed) return;
        closed = true;
        activeStreamCount = Math.max(0, activeStreamCount - 1);
    };

    // Impersonate a standard MP3 file/stream
    const headerTitle = String(currentTitle || 'Sonons Stream')
        .replace(/[\r\n]+/g, ' ')
        .replace(/[^\x20-\x7E]/g, '')
        .trim() || 'Sonons Stream';
    res.header('Content-Type', 'audio/mpeg');
    res.header('ice-name', headerTitle);
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');
    res.header('Expires', '0');
    res.header('Connection', 'keep-alive');
    res.header('Transfer-Encoding', 'chunked');
    res.header('Accept-Ranges', 'none');
    res.flushHeaders();
    if (res.socket) {
        res.socket.setKeepAlive(true, 15000);
        res.socket.setNoDelay(true);
        res.socket.setTimeout(0);
    }

    const ytArgs = [
        '--no-config',
        '--no-warnings',
        '--no-progress',
        '--no-playlist',
        '--extractor-args', YT_EXTRACTOR_ARGS,
        '--user-agent', YT_USER_AGENT,
        '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
        '-o', '-',
        currentYoutubeUrl
    ];
    if (YT_COOKIES) {
        ytArgs.splice(2, 0, '--cookies', YT_COOKIES);
    }
    if (YT_JS_RUNTIME) {
        ytArgs.splice(2, 0, '--js-runtimes', YT_JS_RUNTIME);
    }
    if (YT_FORCE_IPV4) {
        ytArgs.splice(2, 0, '-4');
    }
    const yt = spawn('yt-dlp', ytArgs);

    const ffArgs = [
        '-hide_banner',
        '-loglevel', 'error',
        '-fflags', '+nobuffer',
        '-analyzeduration', '0',
        '-probesize', '32k',
        '-i', 'pipe:0',
        '-vn', '-sn', '-dn',
        '-acodec', 'libmp3lame',
        '-b:a', '192k',
        '-f', 'mp3',
        '-flush_packets', '1',
        'pipe:1'
    ];
    const ff = spawn('ffmpeg', ffArgs);

    yt.stdout.pipe(ff.stdin);

    let ytErr = '';
    yt.stderr.on('data', (chunk) => {
        if (ytErr.length < 2000) ytErr += chunk.toString();
    });

    let ffErr = '';
    ff.stderr.on('data', (chunk) => {
        if (ffErr.length < 2000) ffErr += chunk.toString();
    });

    ff.stdout.pipe(res);

    req.on('close', () => {
        log(`STREAM CLOSED.`);
        markClosed();
        ff.kill();
        yt.kill();
        setTimeout(() => {
            if (!endedNaturally) {
                scheduleRestart('client closed');
            }
        }, 600);
    });

    res.on('error', (e) => {
        if (isEpipe(e)) {
            log(`STREAM EPIPE (client closed).`);
            markClosed();
            ff.kill();
            yt.kill();
            setTimeout(() => {
                if (!endedNaturally) {
                    scheduleRestart('epipe');
                }
            }, 600);
            return;
        }
        log(`RES Error: ${e.message}`);
    });
    ff.stdout.on('error', (e) => {
        if (isEpipe(e)) {
            log(`FF stdout EPIPE (client closed).`);
            return;
        }
        log(`FF stdout error: ${e.message}`);
    });
    ff.stdin.on('error', (e) => {
        if (isEpipe(e)) {
            return;
        }
        log(`FF stdin error: ${e.message}`);
    });
    yt.on('error', (e) => log(`YT Error: ${e.message}`));
    yt.on('close', (code) => {
        log(`YT Exit: code=${code ?? 'null'}`);
        if (ytErr) log(`YT Stderr: ${ytErr.replace(/\s+/g, ' ').trim()}`);
        if (code && code !== 0) {
            ff.kill();
        }
    });
    ff.on('error', (e) => log(`FF Error: ${e.message}`));
    ff.on('close', (code, signal) => {
        log(`FF Exit: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        if (ffErr) log(`FF Stderr: ${ffErr.replace(/\s+/g, ' ').trim()}`);
        if (code === 0) {
            endedNaturally = true;
            if (playlistMode) {
                setTimeout(() => {
                    if (activeStreamCount === 0) {
                        advancePlaylist(lastPlayback?.deviceHost);
                    }
                }, 400);
            }
        }
        if (code && code !== 0) {
            currentDirectUrl = '';
            currentDirectUrlAt = 0;
        }
    });
});

app.listen(PORT, '0.0.0.0', () => {
    log(`Sonons v${VERSION} Ready.`);
});

process.on('uncaughtException', (err) => {
    if (isEpipe(err)) {
        log('WARN: EPIPE ignored (client disconnected).');
        return;
    }
    log(`CRITICAL: ${err.message}`);
});
