const express = require('express');
const { Sonos, AsyncDeviceDiscovery } = require('sonos');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const util = require('util');
const fs = require('fs');
const path = require('path');
const https = require('https');
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
const YT_METADATA_TIMEOUT_MS = Number(process.env.YT_METADATA_TIMEOUT_MS || 5000);
const YT_METADATA_RETRY_TIMEOUT_MS = Number(process.env.YT_METADATA_RETRY_TIMEOUT_MS || 15000);
const YT_DIRECT_URL_WAIT_MS = Math.min(3000, Math.max(0, Number(process.env.YT_DIRECT_URL_WAIT_MS || 1200)));
const YT_OEMBED_TIMEOUT_MS = Number(process.env.YT_OEMBED_TIMEOUT_MS || 10000);

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
const RESTART_BACKOFF_BASE_MS = 1500;
const FORCED_RESTART_DELAY_MS = 250;
let currentDirectUrl = '';
let currentDirectUrlAt = 0;
let currentDirectUrlFor = '';
let currentDirectUrlPromise = null;
let currentDirectUrlPromiseFor = '';
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
let playbackStartToken = 0;
const PLAYBACK_SUPERSEDED_CODE = 'PLAYBACK_SUPERSEDED';

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

const fetchJson = (url, timeoutMs = 10000) =>
    new Promise((resolve, reject) => {
        const req = https.get(
            url,
            { headers: { 'User-Agent': YT_USER_AGENT } },
            (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(new Error(`Invalid JSON: ${err.message}`));
                    }
                });
            }
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error('request timeout'));
        });
    });

const fetchTitleFromOEmbed = async (youtubeUrl) => {
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeUrl)}&format=json`;
    const payload = await fetchJson(endpoint, YT_OEMBED_TIMEOUT_MS);
    if (!payload || typeof payload.title !== 'string') return null;
    const title = payload.title.trim();
    return title || null;
};

const parseDurationFromDirectUrl = (directUrl) => {
    if (!directUrl) return null;
    try {
        const parsed = new URL(directUrl);
        const durRaw = parsed.searchParams.get('dur') || '';
        const dur = Number.parseFloat(durRaw);
        if (!Number.isFinite(dur) || dur <= 0) return null;
        return Math.floor(dur);
    } catch {
        return null;
    }
};
const parseDurationToSeconds = (value = '') => {
    const text = String(value || '').trim();
    if (!text) return null;
    const parts = text.split(':').map((part) => Number(part));
    if (!parts.length || parts.some((part) => Number.isNaN(part) || part < 0)) return null;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
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
const createPlaybackSupersededError = () => {
    const err = new Error('playback superseded by newer request');
    err.code = PLAYBACK_SUPERSEDED_CODE;
    return err;
};
const isPlaybackSupersededError = (err) => err?.code === PLAYBACK_SUPERSEDED_CODE;
const scheduleRestart = (reason, options = {}) => {
    if (!lastPlayback || !currentYoutubeUrl) return;
    const force = Boolean(options.force);
    const restartToken = playbackStartToken;
    const restartUrl = currentYoutubeUrl;

    if (!force && restartAttempts >= MAX_RESTART_ATTEMPTS) {
        log(`- Restart skipped (max attempts): ${reason}`);
        return;
    }
    if (restartTimer) {
        if (!force) return;
        clearTimeout(restartTimer);
        restartTimer = null;
    }

    if (force) {
        restartAttempts = 0;
    }
    restartAttempts += 1;
    const delay = force ? FORCED_RESTART_DELAY_MS : RESTART_BACKOFF_BASE_MS * restartAttempts;
    log(`- Auto-restart scheduled in ${delay}ms (${reason}${force ? ', forced' : ''})`);
    restartTimer = setTimeout(async () => {
        restartTimer = null;
        if (restartToken !== playbackStartToken) {
            log(`- Restart skipped (superseded): ${reason}`);
            return;
        }
        if (!currentYoutubeUrl || currentYoutubeUrl !== restartUrl) {
            log(`- Restart skipped (URL changed): ${reason}`);
            return;
        }
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
            currentDirectUrlFor = '';
            currentDirectUrlPromise = null;
            currentDirectUrlPromiseFor = '';
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
            if (isPlaybackSupersededError(err)) {
                log('- Daily start superseded by newer playback request.');
                return;
            }
            log(`[WARN] Daily start failed: ${err.message}`);
        } finally {
            scheduleDailyStart();
        }
    }, delay);
};

const resolveDirectUrl = async (youtubeUrl) => {
    const normalizedUrl = normalizeYoutubeUrl(youtubeUrl);
    const now = Date.now();
    if (currentDirectUrlFor === normalizedUrl && currentDirectUrl && now - currentDirectUrlAt < DIRECT_URL_TTL_MS) {
        return currentDirectUrl;
    }
    if (currentDirectUrlPromise && currentDirectUrlPromiseFor === normalizedUrl) {
        return currentDirectUrlPromise;
    }
    const cookieFlag = YT_COOKIES ? ` --cookies "${YT_COOKIES}"` : '';
    const jsRuntimeFlag = YT_JS_RUNTIME ? ` --js-runtimes "${YT_JS_RUNTIME}"` : '';
    const ipv4Flag = YT_FORCE_IPV4 ? ' -4' : '';
    currentDirectUrlPromiseFor = normalizedUrl;
    currentDirectUrlPromise = (async () => {
        const { stdout } = await execPromise(
            `yt-dlp --no-config --no-warnings --no-playlist${cookieFlag}${jsRuntimeFlag}${ipv4Flag} --extractor-args "${YT_EXTRACTOR_ARGS}" --user-agent "${YT_USER_AGENT}" -f "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best" -g "${normalizedUrl}"`,
            { maxBuffer: 1024 * 1024 }
        );
        const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (!lines.length) {
            throw new Error('yt-dlp returned empty direct URL');
        }
        const resolvedUrl = lines[0];
        currentDirectUrl = resolvedUrl;
        currentDirectUrlAt = Date.now();
        currentDirectUrlFor = normalizedUrl;
        return resolvedUrl;
    })();
    try {
        return await currentDirectUrlPromise;
    } finally {
        if (currentDirectUrlPromiseFor === normalizedUrl) {
            currentDirectUrlPromise = null;
            currentDirectUrlPromiseFor = '';
        }
    }
};

const buildTrackFromEntry = (entry = {}) => {
    const rawId = entry.id || entry.url || '';
    const id = String(rawId).trim();
    if (!id) return null;
    const url =
        typeof entry.url === 'string' && /^https?:/i.test(entry.url)
            ? entry.url
            : `https://www.youtube.com/watch?v=${id}`;
    const rawDurationSec = Number.isFinite(entry.duration)
        ? Number(entry.duration)
        : parseDurationToSeconds(entry.duration_string || '');
    const durationSec = Number.isFinite(rawDurationSec) ? rawDurationSec : null;
    const durationLabel = entry.duration_string || (durationSec != null ? formatDuration(durationSec) : null);
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

        await startPlayback(deviceHost, nextTrack.url, {
            title: nextTrack.title,
            durationSec: nextTrack.durationSec,
            durationLabel: nextTrack.durationLabel
        });
    } catch (err) {
        if (isPlaybackSupersededError(err)) {
            log('- Playlist advance superseded by newer playback request.');
            return;
        }
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
            if (isPlaybackSupersededError(err)) {
                log('- Auto play on boot superseded by newer playback request.');
                return;
            }
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
    currentDirectUrlFor = '';
    currentDirectUrlPromise = null;
    currentDirectUrlPromiseFor = '';
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
                await startPlayback(lastPlayback.deviceHost, nextTrack.url, {
                    title: nextTrack.title,
                    durationSec: nextTrack.durationSec,
                    durationLabel: nextTrack.durationLabel
                });
            } catch (err) {
                if (isPlaybackSupersededError(err)) {
                    log('- Auto-play after remove superseded by newer playback request.');
                    return;
                }
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
        const { title } = await startPlayback(deviceHost, track.url, {
            title: track.title,
            durationSec: track.durationSec,
            durationLabel: track.durationLabel
        });
        res.send({ status: 'playing', title, index });
    } catch (err) {
        if (isPlaybackSupersededError(err)) {
            log(`[WARN] Playlist start superseded: ${err.message}`);
            res.status(409).send(err.message);
            return;
        }
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

const startPlayback = async (deviceHost, youtubeUrl, fallbackMeta = null) => {
    const startToken = ++playbackStartToken;
    const playbackStartedAt = Date.now();
    const assertStillLatest = () => {
        if (startToken !== playbackStartToken) {
            throw createPlaybackSupersededError();
        }
    };
    const normalizedUrl = normalizeYoutubeUrl(youtubeUrl);
    if (normalizedUrl !== youtubeUrl) {
        log(`- Normalized URL: ${normalizedUrl}`);
    }
    log(`SETUP CLEAN PLAY: ${normalizedUrl} on ${deviceHost}`);

    // 1. UPDATE STATE
    currentYoutubeUrl = normalizedUrl;
    currentDirectUrl = '';
    currentDirectUrlAt = 0;
    currentDirectUrlFor = '';
    currentDirectUrlPromise = null;
    currentDirectUrlPromiseFor = '';
    const prefetchStartedAt = Date.now();
    void resolveDirectUrl(normalizedUrl)
        .then((resolvedDirectUrl) => {
            const elapsedMs = Date.now() - prefetchStartedAt;
            if (startToken !== playbackStartToken || currentYoutubeUrl !== normalizedUrl) return;
            const inferredDuration = parseDurationFromDirectUrl(resolvedDirectUrl);
            if (inferredDuration && (currentDurationSec == null || !Number.isFinite(currentDurationSec) || currentDurationSec <= 0)) {
                currentDurationSec = inferredDuration;
                currentDurationLabel = formatDuration(inferredDuration);
                log(`- Duration inferred from direct URL (${inferredDuration}s)`);
            }
            log(`- Direct URL prefetched (${elapsedMs}ms)`);
            if (activeStreamCount === 0 && lastPlayback?.deviceHost && lastPlayback.startedAt >= playbackStartedAt) {
                log('- Direct URL ready while idle, forcing restart');
                scheduleRestart('direct URL ready', { force: true });
            }
        })
        .catch((err) => log(`[WARN] Direct URL prefetch failed: ${err.message}`));

    const coordinatorHost = await resolveCoordinatorHost(deviceHost);
    assertStillLatest();
    if (coordinatorHost !== deviceHost) {
        log(`- Coordinator resolved: ${deviceHost} -> ${coordinatorHost}`);
    }
    const device = new Sonos(coordinatorHost);
    try {
        await withRetry(() => device.stop(), { label: 'Preflight stop', attempts: 2, baseDelay: 300 });
    } catch (err) {
        log(`[WARN] Preflight stop failed: ${err.message}`);
    }
    assertStillLatest();
    const cookieFlag = YT_COOKIES ? ` --cookies "${YT_COOKIES}"` : '';
    const jsRuntimeFlag = YT_JS_RUNTIME ? ` --js-runtimes "${YT_JS_RUNTIME}"` : '';
    const ipv4Flag = YT_FORCE_IPV4 ? ' -4' : '';
    const fallbackTitle = typeof fallbackMeta?.title === 'string' ? fallbackMeta.title.trim() : '';
    const fallbackDurationSec = Number.isFinite(fallbackMeta?.durationSec) ? Number(fallbackMeta.durationSec) : null;
    const fallbackDurationLabel = typeof fallbackMeta?.durationLabel === 'string' ? fallbackMeta.durationLabel.trim() : '';
    let title = fallbackTitle || 'Sonons Audio';
    let art = '';
    let durationSec = fallbackDurationSec;
    let durationLabel = fallbackDurationLabel || (durationSec != null ? formatDuration(durationSec) : null);
    let metadataProbeFailed = false;
    const probeMetadata = async (timeoutMs) => {
        const { stdout } = await execPromise(
            `yt-dlp --no-config --no-warnings --no-playlist${cookieFlag}${jsRuntimeFlag}${ipv4Flag} --extractor-args "${YT_EXTRACTOR_ARGS}" --user-agent "${YT_USER_AGENT}" --print "%(title)s" --print "%(thumbnail)s" --print "%(duration)s" --print "%(duration_string)s" "${normalizedUrl}"`,
            { maxBuffer: 1024 * 1024, timeout: timeoutMs }
        );
        const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const parsedDuration = Number(lines[2]);
        const parsedDurationSec = Number.isFinite(parsedDuration)
            ? parsedDuration
            : parseDurationToSeconds(lines[3] || '');
        return {
            title: lines[0] || '',
            art: lines[1] || '',
            durationSec: Number.isFinite(parsedDurationSec) ? parsedDurationSec : null,
            durationLabel: lines[3] || null
        };
    };
    try {
        const metadata = await probeMetadata(YT_METADATA_TIMEOUT_MS);
        title = metadata.title || title;
        art = metadata.art || art;
        durationSec = metadata.durationSec != null ? metadata.durationSec : durationSec;
        durationLabel = metadata.durationLabel || durationLabel;
    } catch (err) {
        metadataProbeFailed = true;
        const shortErr = String(err?.message || err).split('\n')[0];
        log(`[WARN] Metadata probe failed: ${shortErr}`);
    }
    assertStillLatest();

    currentTitle = title;
    currentDurationSec = durationSec;
    currentDurationLabel = durationLabel;
    if (metadataProbeFailed && (!fallbackTitle || !currentTitle || currentTitle === 'Sonons Audio' || currentTitle === 'Sonons Stream')) {
        void (async () => {
            try {
                const oembedTitle = await fetchTitleFromOEmbed(normalizedUrl);
                if (!oembedTitle) return;
                if (startToken !== playbackStartToken || currentYoutubeUrl !== normalizedUrl) return;
                if (currentTitle === 'Sonons Audio' || currentTitle === 'Sonons Stream' || !currentTitle) {
                    currentTitle = oembedTitle;
                    log('- Metadata title refreshed via oEmbed');
                }
            } catch (oembedErr) {
                const shortOembedErr = String(oembedErr?.message || oembedErr).split('\n')[0];
                log(`[WARN] oEmbed title fetch failed: ${shortOembedErr}`);
            }
        })();
    }
    if (metadataProbeFailed && (!fallbackTitle || durationSec == null)) {
        void (async () => {
            try {
                const delayedMeta = await probeMetadata(YT_METADATA_RETRY_TIMEOUT_MS);
                if (startToken !== playbackStartToken || currentYoutubeUrl !== normalizedUrl) return;
                const nextTitle = delayedMeta.title || currentTitle || 'Sonons Audio';
                const nextDurationSec = delayedMeta.durationSec != null ? delayedMeta.durationSec : currentDurationSec;
                const nextDurationLabel = delayedMeta.durationLabel || (nextDurationSec != null ? formatDuration(nextDurationSec) : currentDurationLabel);
                const changed =
                    nextTitle !== currentTitle
                    || nextDurationSec !== currentDurationSec
                    || nextDurationLabel !== currentDurationLabel;
                currentTitle = nextTitle;
                if (delayedMeta.art) art = delayedMeta.art;
                currentDurationSec = nextDurationSec;
                currentDurationLabel = nextDurationLabel;
                if (changed) {
                    log('- Metadata refreshed after delayed probe');
                }
            } catch (retryErr) {
                const shortRetryErr = String(retryErr?.message || retryErr).split('\n')[0];
                log(`[WARN] Metadata retry failed: ${shortRetryErr}`);
            }
        })();
    }
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
        assertStillLatest();
        try {
            log(`- Trying AVTransport: ${option.label}`);
            await withRetry(
                () => device.setAVTransportURI({ uri: option.uri, metadata: option.metadata, onlySetUri: true }),
                { label: `Set AVTransport (${option.label})`, attempts: 3, baseDelay: 400 }
            );
            assertStillLatest();
            log(`- Starting playback...`);
            await withRetry(() => device.play(), { label: 'Play', attempts: 3, baseDelay: 400 });
            assertStillLatest();
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
            if (isPlaybackSupersededError(err)) {
                throw err;
            }
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
        if (isPlaybackSupersededError(e)) {
            log(`[WARN] Play superseded: ${e.message}`);
            res.status(409).send(e.message);
            return;
        }
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
        playbackStartToken += 1;
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
        playbackStartToken += 1;
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
        playlistIndex: playlistMode ? playlistCurrentIndex : null,
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

    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
        log('- Pending restart canceled (stream reconnected)');
    }
    restartAttempts = 0;

    activeStreamCount += 1;
    const streamToken = playbackStartToken;
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

    const hasFreshDirectUrl =
        currentDirectUrlFor === currentYoutubeUrl
        && currentDirectUrl
        && (Date.now() - currentDirectUrlAt < DIRECT_URL_TTL_MS);
    let directUrl = '';
    if (hasFreshDirectUrl) {
        directUrl = currentDirectUrl;
        log('- Stream source: direct URL cache');
    } else {
        const waitMs = Math.max(0, YT_DIRECT_URL_WAIT_MS);
        if (waitMs > 0) {
            const startedAt = Date.now();
            const pendingDirectUrl = resolveDirectUrl(currentYoutubeUrl);
            pendingDirectUrl.catch(() => {});
            try {
                directUrl = await Promise.race([
                    pendingDirectUrl,
                    new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('direct-url-timeout')), waitMs);
                    })
                ]);
                log(`- Stream source: direct URL wait-hit (${Date.now() - startedAt}ms)`);
            } catch (err) {
                const msg = String(err?.message || err);
                if (msg.includes('direct-url-timeout')) {
                    log(`- Stream source: yt-dlp pipe (direct URL wait timeout ${waitMs}ms)`);
                } else {
                    log(`[WARN] Direct URL wait failed: ${msg}`);
                    log('- Stream source: yt-dlp pipe');
                }
            }
        } else {
            log('- Stream source: yt-dlp pipe');
        }
    }

    const ffArgs = directUrl
        ? [
            '-hide_banner',
            '-loglevel', 'error',
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '3',
            '-reconnect_at_eof', '1',
            '-user_agent', YT_USER_AGENT,
            '-headers', 'Referer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com\r\n',
            '-fflags', '+nobuffer',
            '-analyzeduration', '0',
            '-probesize', '32k',
            '-i', directUrl,
            '-vn', '-sn', '-dn',
            '-acodec', 'libmp3lame',
            '-b:a', '192k',
            '-f', 'mp3',
            '-flush_packets', '1',
            'pipe:1'
        ]
        : [
            '-hide_banner',
            '-loglevel', 'error',
            '-thread_queue_size', '4096',
            '-analyzeduration', '10M',
            '-probesize', '5M',
            '-fflags', '+discardcorrupt',
            '-err_detect', 'ignore_err',
            '-i', 'pipe:0',
            '-vn', '-sn', '-dn',
            '-acodec', 'libmp3lame',
            '-b:a', '192k',
            '-f', 'mp3',
            '-flush_packets', '1',
            'pipe:1'
        ];
    const ff = spawn('ffmpeg', ffArgs);
    let yt = null;
    let ytErr = '';

    if (!directUrl) {
        const ytArgs = ['--no-config', '--no-warnings', '--no-playlist', '--no-progress'];
        if (YT_COOKIES) ytArgs.push('--cookies', YT_COOKIES);
        if (YT_JS_RUNTIME) ytArgs.push('--js-runtimes', YT_JS_RUNTIME);
        if (YT_FORCE_IPV4) ytArgs.push('-4');
        ytArgs.push(
            '--extractor-args', YT_EXTRACTOR_ARGS,
            '--user-agent', YT_USER_AGENT,
            '-f', '140/251/250/249/bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/18/best',
            '-o', '-',
            currentYoutubeUrl
        );
        yt = spawn('yt-dlp', ytArgs);
        yt.stderr.on('data', (chunk) => {
            if (ytErr.length < 2000) ytErr += chunk.toString();
        });
        yt.on('error', (e) => log(`YT Error: ${e.message}`));
        yt.on('close', (code, signal) => {
            log(`YT Exit: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
            if (ytErr) log(`YT Stderr: ${ytErr.replace(/\s+/g, ' ').trim()}`);
        });
        yt.stdout.on('error', (e) => {
            if (isEpipe(e)) return;
            log(`YT stdout error: ${e.message}`);
        });
        ff.stdin.on('error', (e) => {
            if (isEpipe(e)) return;
            log(`FF stdin error: ${e.message}`);
        });
        yt.stdout.pipe(ff.stdin);
    }

    let ffErr = '';
    ff.stderr.on('data', (chunk) => {
        if (ffErr.length < 2000) ffErr += chunk.toString();
    });

    ff.stdout.pipe(res);

    req.on('close', () => {
        log(`STREAM CLOSED.`);
        markClosed();
        if (yt && !yt.killed) yt.kill();
        if (!ff.killed) ff.kill();
        setTimeout(() => {
            if (streamToken !== playbackStartToken) return;
            if (endedNaturally) return;
            if (activeStreamCount > 0) return;
            scheduleRestart('client closed');
        }, 300);
    });

    res.on('error', (e) => {
        if (isEpipe(e)) {
            log(`STREAM EPIPE (client closed).`);
            markClosed();
            if (yt && !yt.killed) yt.kill();
            if (!ff.killed) ff.kill();
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
    ff.on('error', (e) => log(`FF Error: ${e.message}`));
    ff.on('close', (code, signal) => {
        log(`FF Exit: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        if (ffErr) log(`FF Stderr: ${ffErr.replace(/\s+/g, ' ').trim()}`);
        if (yt && !yt.killed) yt.kill();
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
        // Keep cached direct URL on client disconnect; only clear on real stream failures.
        if (code && code !== 0 && !closed) {
            currentDirectUrl = '';
            currentDirectUrlAt = 0;
            currentDirectUrlFor = '';
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
