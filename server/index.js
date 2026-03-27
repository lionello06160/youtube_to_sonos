const express = require('express');
const { Sonos, AsyncDeviceDiscovery } = require('sonos');
const cors = require('cors');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const multer = require('multer');
const util = require('util');
const fs = require('fs');
const path = require('path');
const https = require('https');
const execFilePromise = util.promisify(execFile);

const app = express();
const PORT = 3005;
const HOST_IP = '10.10.4.14';
const VERSION = '8.0 (Clean URI)';
const PLAYLIST_PATH = path.join(__dirname, 'playlist.json');
const LIBRARY_PATH = path.join(__dirname, 'library.json');
const DEFAULT_LOOP_MODE = 'all';
const YT_COOKIES_FILE = path.join(__dirname, 'yt-cookies.txt');
const YT_COOKIES = process.env.YT_COOKIES || (fs.existsSync(YT_COOKIES_FILE) ? YT_COOKIES_FILE : '');
const YT_DLP_ENV = 'YT_DLP_BIN';
const FFMPEG_ENV = 'FFMPEG_BIN';
const YT_JS_RUNTIME = process.env.YT_JS_RUNTIME || 'node';
const YT_EXTRACTOR_ARGS = process.env.YT_EXTRACTOR_ARGS || 'youtube:player_client=mweb,web,tvhtml5';
const YT_USER_AGENT = process.env.YT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const YT_FORCE_IPV4 = String(process.env.YT_FORCE_IPV4 || 'true').toLowerCase() !== 'false';
const YT_METADATA_TIMEOUT_MS = Number(process.env.YT_METADATA_TIMEOUT_MS || 5000);
const YT_METADATA_RETRY_TIMEOUT_MS = Number(process.env.YT_METADATA_RETRY_TIMEOUT_MS || 15000);
const YT_DIRECT_URL_WAIT_MS = Math.min(5000, Math.max(0, Number(process.env.YT_DIRECT_URL_WAIT_MS || 2500)));
const YT_DIRECT_URL_RESOLVE_TIMEOUT_MS = Number(process.env.YT_DIRECT_URL_RESOLVE_TIMEOUT_MS || 60000);
const YT_OEMBED_TIMEOUT_MS = Number(process.env.YT_OEMBED_TIMEOUT_MS || 10000);
const YT_WATCH_TITLE_TIMEOUT_MS = Number(process.env.YT_WATCH_TITLE_TIMEOUT_MS || 8000);
const YT_TITLE_FALLBACK_TIMEOUT_MS = Number(process.env.YT_TITLE_FALLBACK_TIMEOUT_MS || 20000);
const YT_DOWNLOAD_TIMEOUT_MS = Number(process.env.YT_DOWNLOAD_TIMEOUT_MS || 15 * 60 * 1000);
const PLAYBACK_MONITOR_INTERVAL_MS = Number(process.env.PLAYBACK_MONITOR_INTERVAL_MS || 3000);
const MEDIA_CACHE_DIR = path.join(__dirname, 'media-cache');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const BINARY_PATHS = {
    'yt-dlp': [
        '/opt/homebrew/bin/yt-dlp',
        '/usr/local/bin/yt-dlp'
    ],
    ffmpeg: [
        '/opt/homebrew/bin/ffmpeg',
        '/usr/local/bin/ffmpeg'
    ]
};

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
let currentMediaFile = '';
let currentMediaToken = '';
let currentPlaybackState = 'stopped';
let currentPlaybackPositionSec = 0;
let currentPlaybackPositionUpdatedAt = 0;
let currentSourceType = 'idle';
let currentLibraryItemId = null;
let playbackMonitorTimer = null;
let playbackMonitorBusy = false;
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
let libraryItems = [];
let playlistItems = [];
let playlistCurrentIndex = null;
let playlistCurrentUid = null;
let playlistMode = false;
let loopMode = DEFAULT_LOOP_MODE;
let shuffleOrder = [];
let shufflePos = 0;
let playlistAdvanceLock = false;
let libraryAdvanceLock = false;
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
const clampPlaybackPosition = (positionSec, durationSec) => {
    const nextPosition = Number.isFinite(positionSec) ? Math.max(0, Math.floor(positionSec)) : 0;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
        return nextPosition;
    }
    return Math.min(nextPosition, Math.max(0, Math.floor(durationSec)));
};
const getEffectiveStopTime = () => {
    const parsed = parseTime(autoConfig.autoStopTime);
    if (parsed) return formatTimeParts(parsed.hour, parsed.minute);
    return formatTimeParts(DAILY_STOP_HOUR, DAILY_STOP_MINUTE);
};
const isExecutableFile = (candidate) => {
    if (!candidate) return false;
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
};
const resolveBinaryPath = (binaryName, configuredPath = '') => {
    const candidates = [];
    if (configuredPath) candidates.push(configuredPath);
    const pathDirs = String(process.env.PATH || '')
        .split(path.delimiter)
        .map((segment) => segment.trim())
        .filter(Boolean);
    for (const dir of pathDirs) {
        candidates.push(path.join(dir, binaryName));
    }
    candidates.push(...(BINARY_PATHS[binaryName] || []));
    const seen = new Set();
    for (const candidate of candidates) {
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        if (isExecutableFile(candidate)) return candidate;
    }
    return null;
};
const RESOLVED_BINARIES = {
    'yt-dlp': resolveBinaryPath('yt-dlp', process.env[YT_DLP_ENV] || ''),
    ffmpeg: resolveBinaryPath('ffmpeg', process.env[FFMPEG_ENV] || '')
};
const YT_DLP_BIN = RESOLVED_BINARIES['yt-dlp'];
const FFMPEG_BIN = RESOLVED_BINARIES.ffmpeg;
const FFPROBE_BIN = (() => {
    const ffmpegDir = FFMPEG_BIN ? path.dirname(FFMPEG_BIN) : '';
    const candidate = ffmpegDir ? path.join(ffmpegDir, 'ffprobe') : '';
    return resolveBinaryPath('ffprobe', process.env.FFPROBE_BIN || candidate);
})();
const createMissingDependencyError = (missingNames) => {
    const missing = Array.from(new Set(missingNames)).filter(Boolean);
    const plural = missing.length > 1;
    const envVars = missing
        .map((name) => (name === 'yt-dlp' ? YT_DLP_ENV : FFMPEG_ENV))
        .join('/');
    const installCmd = `brew install ${missing.join(' ')}`;
    return new Error(
        `Missing ${plural ? 'dependencies' : 'dependency'}: ${missing.join(', ')}. `
        + `Install with "${installCmd}" or set ${envVars} to the executable path.`
    );
};
const assertDependenciesAvailable = (...requiredNames) => {
    const missing = requiredNames.filter((name) => !RESOLVED_BINARIES[name]);
    if (missing.length) {
        throw createMissingDependencyError(missing);
    }
};
const buildBinaryEnv = () => {
    const env = { ...process.env };
    const prependDirs = [
        YT_DLP_BIN ? path.dirname(YT_DLP_BIN) : '',
        FFMPEG_BIN ? path.dirname(FFMPEG_BIN) : ''
    ].filter(Boolean);
    if (prependDirs.length) {
        const existingPath = String(env.PATH || '');
        env.PATH = `${prependDirs.join(path.delimiter)}${existingPath ? `${path.delimiter}${existingPath}` : ''}`;
    }
    return env;
};
const execBinary = (binaryName, args, options = {}) => {
    assertDependenciesAvailable(binaryName);
    return execFilePromise(RESOLVED_BINARIES[binaryName], args, {
        env: buildBinaryEnv(),
        ...options
    });
};
const execFfprobe = (args, options = {}) => {
    if (!FFPROBE_BIN) {
        throw new Error('Missing dependency: ffprobe. Install ffmpeg or set FFPROBE_BIN.');
    }
    return execFilePromise(FFPROBE_BIN, args, {
        env: buildBinaryEnv(),
        ...options
    });
};
const ensureMediaCacheDir = () => {
    fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
};
const clearMediaFiles = (keepPaths = []) => {
    ensureMediaCacheDir();
    const keep = new Set(keepPaths.filter(Boolean).map((value) => path.resolve(value)));
    for (const entry of fs.readdirSync(MEDIA_CACHE_DIR)) {
        const filePath = path.join(MEDIA_CACHE_DIR, entry);
        if (keep.has(path.resolve(filePath))) continue;
        try {
            fs.unlinkSync(filePath);
        } catch (err) {
            log(`[WARN] Failed to delete cached media ${entry}: ${err.message}`);
        }
    }
};
const clearMediaFilesByPrefix = (prefix = '') => {
    if (!prefix) return;
    ensureMediaCacheDir();
    for (const entry of fs.readdirSync(MEDIA_CACHE_DIR)) {
        if (!entry.startsWith(`${prefix}.`)) continue;
        try {
            fs.unlinkSync(path.join(MEDIA_CACHE_DIR, entry));
        } catch (err) {
            log(`[WARN] Failed to delete partial media ${entry}: ${err.message}`);
        }
    }
};
const resetMediaState = ({ keepCurrentFile = false, keepPaths = [] } = {}) => {
    const nextKeepPaths = [...keepPaths];
    if (keepCurrentFile && currentMediaFile) {
        nextKeepPaths.push(currentMediaFile);
    }
    if (!keepCurrentFile && nextKeepPaths.length === 0) {
        currentMediaFile = '';
        currentMediaToken = '';
    }
    clearMediaFiles(nextKeepPaths);
};
const ensureUploadsDir = () => {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
};
const stripExtension = (value = '') => value.replace(/\.[^.]+$/, '');
const decodeUploadText = (value = '') => {
    const raw = String(value || '');
    if (!raw) return raw;
    try {
        const decoded = Buffer.from(raw, 'latin1').toString('utf8');
        if (decoded.includes('\uFFFD')) return raw;
        const decodedMeaningful = /[\u3040-\u30ff\u3400-\u9fff]/.test(decoded);
        const rawMojibakeLike = /[ÃÂÅÆÇÉÐÑÕØÙÚÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/.test(raw);
        if ((decodedMeaningful || rawMojibakeLike) && decoded !== raw) {
            return decoded;
        }
    } catch {
        // ignore decode failures
    }
    return raw;
};
const sanitizeLibraryTitle = (value = '') =>
    decodeUploadText(String(value || ''))
        .replace(/\.[^.]+$/, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || 'Untitled Upload';
const normalizeLibraryItem = (item = {}) => {
    const originalName = decodeUploadText(item.originalName || '');
    const title = sanitizeLibraryTitle(item.title || originalName || '');
    return {
        ...item,
        title,
        originalName,
        durationSec: Number.isFinite(item.durationSec) ? item.durationSec : null,
        durationLabel: item.durationLabel || (Number.isFinite(item.durationSec) ? formatDuration(item.durationSec) : null)
    };
};
const sortLibraryItems = (items = []) =>
    [...items].sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
const persistLibraryState = () => {
    const payload = libraryItems.map((item) => ({
        id: item.id,
        title: item.title,
        originalName: item.originalName,
        storedName: item.storedName,
        mimeType: item.mimeType,
        size: item.size,
        durationSec: item.durationSec ?? null,
        durationLabel: item.durationLabel ?? null,
        uploadedAt: item.uploadedAt
    }));
    fs.writeFileSync(LIBRARY_PATH, JSON.stringify(payload, null, 2));
};
const getLibraryItemPath = (item) => path.join(UPLOADS_DIR, item.storedName);
const syncLibraryWithFiles = () => {
    ensureUploadsDir();
    const existing = new Set(fs.readdirSync(UPLOADS_DIR));
    libraryItems = sortLibraryItems(
        libraryItems.filter((item) => item.storedName && existing.has(item.storedName))
    );
};
const probeAudioDuration = async (filePath) => {
    try {
        const { stdout } = await execFfprobe([
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { timeout: 10000, maxBuffer: 1024 * 128 });
        const seconds = Math.floor(Number.parseFloat(String(stdout || '').trim()));
        return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    } catch (err) {
        log(`[WARN] Failed to probe duration for ${path.basename(filePath)}: ${err.message}`);
        return null;
    }
};
const syncPlaybackProgress = (track = {}) => {
    const trackPosition = Number.isFinite(track.position) ? track.position : 0;
    const trackDuration = Number.isFinite(track.duration) && track.duration > 0 ? Math.floor(track.duration) : null;
    if (trackDuration != null) {
        currentDurationSec = trackDuration;
        currentDurationLabel = formatDuration(trackDuration);
    }
    currentPlaybackPositionSec = clampPlaybackPosition(trackPosition, trackDuration ?? currentDurationSec);
    currentPlaybackPositionUpdatedAt = Date.now();
};
const getEffectivePlaybackPositionSec = () => {
    const basePosition = Number.isFinite(currentPlaybackPositionSec) ? currentPlaybackPositionSec : 0;
    if (currentPlaybackState !== 'playing' || !currentPlaybackPositionUpdatedAt) {
        return clampPlaybackPosition(basePosition, currentDurationSec);
    }
    const elapsedSec = Math.max(0, Math.floor((Date.now() - currentPlaybackPositionUpdatedAt) / 1000));
    return clampPlaybackPosition(basePosition + elapsedSec, currentDurationSec);
};
const ensureLibraryDurations = async () => {
    let changed = false;
    for (const item of libraryItems) {
        if (Number.isFinite(item.durationSec) && item.durationSec > 0) continue;
        const filePath = getLibraryItemPath(item);
        if (!fs.existsSync(filePath)) continue;
        const durationSec = await probeAudioDuration(filePath);
        if (durationSec == null) continue;
        item.durationSec = durationSec;
        item.durationLabel = formatDuration(durationSec);
        changed = true;
    }
    if (changed) persistLibraryState();
};
const loadLibraryState = () => {
    ensureUploadsDir();
    if (!fs.existsSync(LIBRARY_PATH)) {
        libraryItems = [];
        return;
    }
    try {
        const raw = fs.readFileSync(LIBRARY_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        libraryItems = Array.isArray(parsed) ? sortLibraryItems(parsed.map(normalizeLibraryItem)) : [];
        syncLibraryWithFiles();
        persistLibraryState();
    } catch (err) {
        log(`[WARN] Failed to read library.json: ${err.message}`);
        libraryItems = [];
    }
};
const libraryStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        ensureUploadsDir();
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const id = crypto.randomUUID();
        const ext = path.extname(file.originalname || '').toLowerCase() || '.bin';
        cb(null, `${id}${ext}`);
    }
});
const uploadLibraryFiles = multer({
    storage: libraryStorage,
    limits: {
        fileSize: 1024 * 1024 * 512
    }
});
const downloadAudioFile = async (youtubeUrl, token) => {
    assertDependenciesAvailable('yt-dlp', 'ffmpeg');
    ensureMediaCacheDir();
    const outputTemplate = path.join(MEDIA_CACHE_DIR, `${token}.%(ext)s`);
    const finalPath = path.join(MEDIA_CACHE_DIR, `${token}.mp3`);
    const args = ['--no-config', '--no-warnings', '--no-playlist', '--no-progress'];
    if (YT_COOKIES) args.push('--cookies', YT_COOKIES);
    if (YT_JS_RUNTIME) args.push('--js-runtimes', YT_JS_RUNTIME);
    if (YT_FORCE_IPV4) args.push('-4');
    args.push(
        '--extractor-args', YT_EXTRACTOR_ARGS,
        '--user-agent', YT_USER_AGENT,
        '--ffmpeg-location', path.dirname(FFMPEG_BIN),
        '-f', 'bestaudio/best',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '-o', outputTemplate,
        youtubeUrl
    );
    log(`- Downloading audio to cache (${token})`);
    try {
        await execBinary('yt-dlp', args, {
            maxBuffer: 1024 * 1024 * 2,
            timeout: YT_DOWNLOAD_TIMEOUT_MS
        });
    } catch (err) {
        clearMediaFilesByPrefix(token);
        throw err;
    }
    if (!fs.existsSync(finalPath)) {
        throw new Error(`Downloaded file missing: ${path.basename(finalPath)}`);
    }
    return finalPath;
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

const fetchText = (url, timeoutMs = 10000) =>
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
                    resolve(data);
                });
            }
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error('request timeout'));
        });
    });

const decodeHtmlEntities = (value = '') =>
    String(value)
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');

const sanitizeFetchedTitle = (value = '') => {
    const normalized = decodeHtmlEntities(String(value || ''))
        .replace(/\s+/g, ' ')
        .replace(/\s*-\s*YouTube\s*$/i, '')
        .trim();
    if (!normalized) return null;
    if (/^sonons (audio|stream)$/i.test(normalized)) return null;
    return normalized;
};

const fetchTitleFromOEmbed = async (youtubeUrl) => {
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeUrl)}&format=json`;
    const payload = await fetchJson(endpoint, YT_OEMBED_TIMEOUT_MS);
    if (!payload || typeof payload.title !== 'string') return null;
    return sanitizeFetchedTitle(payload.title);
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

const fetchTitleFromWatchPage = async (youtubeUrl) => {
    const html = await fetchText(youtubeUrl, YT_WATCH_TITLE_TIMEOUT_MS);
    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (ogTitleMatch?.[1]) {
        return sanitizeFetchedTitle(ogTitleMatch[1]);
    }
    const metaTitleMatch = html.match(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i);
    if (metaTitleMatch?.[1]) {
        return sanitizeFetchedTitle(metaTitleMatch[1]);
    }
    const titleTagMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleTagMatch?.[1]) {
        return sanitizeFetchedTitle(titleTagMatch[1]);
    }
    return null;
};

const fetchTitleViaYtDlp = async (youtubeUrl, timeoutMs = YT_TITLE_FALLBACK_TIMEOUT_MS) => {
    const args = ['--no-config', '--no-warnings', '--no-playlist', '--skip-download'];
    if (YT_COOKIES) args.push('--cookies', YT_COOKIES);
    if (YT_JS_RUNTIME) args.push('--js-runtimes', YT_JS_RUNTIME);
    if (YT_FORCE_IPV4) args.push('-4');
    args.push(
        '--extractor-args', YT_EXTRACTOR_ARGS,
        '--user-agent', YT_USER_AGENT,
        '--print', '%(title)s',
        youtubeUrl
    );
    const { stdout } = await execBinary('yt-dlp', args, { maxBuffer: 1024 * 256, timeout: timeoutMs });
    const firstLine = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return sanitizeFetchedTitle(firstLine || '');
};

const resolveTitleFallback = async (youtubeUrl) => {
    const attempts = [
        { label: 'oEmbed', fn: () => fetchTitleFromOEmbed(youtubeUrl) },
        { label: 'watch page', fn: () => fetchTitleFromWatchPage(youtubeUrl) },
        { label: 'yt-dlp title', fn: () => fetchTitleViaYtDlp(youtubeUrl) }
    ];
    for (const attempt of attempts) {
        try {
            const title = await attempt.fn();
            if (title) {
                return { title, source: attempt.label };
            }
        } catch (err) {
            const shortErr = String(err?.message || err).split('\n')[0];
            log(`[WARN] ${attempt.label} title fetch failed: ${shortErr}`);
        }
    }
    return null;
};

const isGenericPlaybackTitle = (value = '') => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return true;
    if (normalized === 'sonons audio' || normalized === 'sonons stream') return true;
    return /^youtube[:\s.-]*[a-z0-9_-]{6,}$/i.test(normalized);
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
log(`Binary yt-dlp: ${YT_DLP_BIN || 'missing'}`);
log(`Binary ffmpeg: ${FFMPEG_BIN || 'missing'}`);
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
        const stopHost = lastPlayback?.deviceHost || '';
        playbackStartToken += 1;
        try {
            if (stopHost) {
                const device = new Sonos(stopHost);
                await device.stop();
                log('Daily stop: playback stopped.');
            }
        } catch (err) {
            log(`[WARN] Daily stop failed: ${err.message}`);
        } finally {
            resetPlaybackState();
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
        const cachedDurationSec = parseDurationFromDirectUrl(currentDirectUrl);
        return {
            url: currentDirectUrl,
            title: '',
            durationSec: cachedDurationSec,
            durationLabel: cachedDurationSec != null ? formatDuration(cachedDurationSec) : null
        };
    }
    if (currentDirectUrlPromise && currentDirectUrlPromiseFor === normalizedUrl) {
        return currentDirectUrlPromise;
    }
    currentDirectUrlPromiseFor = normalizedUrl;
    currentDirectUrlPromise = (async () => {
        const args = ['--no-config', '--no-warnings', '--no-playlist'];
        if (YT_COOKIES) args.push('--cookies', YT_COOKIES);
        if (YT_JS_RUNTIME) args.push('--js-runtimes', YT_JS_RUNTIME);
        if (YT_FORCE_IPV4) args.push('-4');
        args.push(
            '--extractor-args', YT_EXTRACTOR_ARGS,
            '--user-agent', YT_USER_AGENT,
            '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
            '-g', normalizedUrl
        );
        const { stdout } = await execBinary('yt-dlp', args, {
            maxBuffer: 1024 * 1024,
            timeout: YT_DIRECT_URL_RESOLVE_TIMEOUT_MS
        });
        const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const resolvedUrl = lines.find((line) => /^https?:\/\//i.test(line));
        if (!resolvedUrl) {
            throw new Error('yt-dlp returned empty direct URL');
        }
        const directDurationSec = parseDurationFromDirectUrl(resolvedUrl);
        const directDurationLabel = directDurationSec != null ? formatDuration(directDurationSec) : null;
        currentDirectUrl = resolvedUrl;
        currentDirectUrlAt = Date.now();
        currentDirectUrlFor = normalizedUrl;
        return {
            url: resolvedUrl,
            title: '',
            durationSec: directDurationSec,
            durationLabel: directDurationLabel
        };
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
    const directUrlCandidate = [entry.webpage_url, entry.url, entry.original_url]
        .find((value) => typeof value === 'string' && /^https?:/i.test(value));
    const rawId = entry.id || entry.url || entry.webpage_url || entry.original_url || '';
    let id = String(rawId).trim();
    if (/^https?:/i.test(id)) {
        id = extractVideoIdFromYoutubeUrl(id) || id;
    }
    if (!id) return null;
    const url = directUrlCandidate || `https://www.youtube.com/watch?v=${id}`;
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
    const normalizedUrl = normalizeYoutubeUrl(inputUrl);
    const args = ['--no-config', '--no-warnings', '--flat-playlist'];
    if (YT_COOKIES) args.push('--cookies', YT_COOKIES);
    if (YT_JS_RUNTIME) args.push('--js-runtimes', YT_JS_RUNTIME);
    if (YT_FORCE_IPV4) args.push('-4');
    args.push(
        '--extractor-args', YT_EXTRACTOR_ARGS,
        '--user-agent', YT_USER_AGENT,
        '--dump-single-json', normalizedUrl
    );
    const { stdout } = await execBinary('yt-dlp', args, {
        maxBuffer: 1024 * 1024 * 2,
        timeout: 30000
    });
    const payload = JSON.parse(stdout);
    const entries = Array.isArray(payload?.entries) ? payload.entries : [payload];
    const tracks = entries.map(buildTrackFromEntry).filter(Boolean);
    if (!tracks.length) {
        throw new Error('No playable tracks found in the provided URL');
    }
    return tracks;
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
const advanceLibraryPlayback = async (deviceHost) => {
    if (libraryAdvanceLock) return;
    if (!currentLibraryItemId || !libraryItems.length || !deviceHost) return;
    libraryAdvanceLock = true;
    try {
        const currentIndex = libraryItems.findIndex((item) => item.id === currentLibraryItemId);
        if (currentIndex < 0) return;
        let nextIndex = currentIndex;
        if (loopMode === 'single') {
            // keep same item
        } else if (loopMode === 'shuffle') {
            if (libraryItems.length > 1) {
                do {
                    nextIndex = Math.floor(Math.random() * libraryItems.length);
                } while (nextIndex === currentIndex);
            }
        } else {
            nextIndex = (currentIndex + 1) % libraryItems.length;
        }
        const nextItem = libraryItems[nextIndex];
        if (!nextItem) return;
        await startUploadedPlayback(deviceHost, nextItem);
    } catch (err) {
        if (isPlaybackSupersededError(err)) {
            log('- Library advance superseded by newer playback request.');
            return;
        }
        log(`[WARN] Library advance failed: ${err.message}`);
    } finally {
        libraryAdvanceLock = false;
    }
};

log(`BOOT: Starting Sonons v${VERSION}...`);
ensureMediaCacheDir();
ensureUploadsDir();
loadAutoConfig();
loadLibraryState();
loadPlaylistState();
if (YT_COOKIES) {
    log(`YT cookies enabled: ${YT_COOKIES}`);
}
if (YT_JS_RUNTIME) {
    log(`YT JS runtime: ${YT_JS_RUNTIME}`);
}
log(`YT extractor args: ${YT_EXTRACTOR_ARGS}`);
log(`Media cache: ${MEDIA_CACHE_DIR}`);
log(`Uploads dir: ${UPLOADS_DIR}`);
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

const stopPlaybackMonitor = () => {
    if (playbackMonitorTimer) {
        clearInterval(playbackMonitorTimer);
        playbackMonitorTimer = null;
    }
    playbackMonitorBusy = false;
};
const startPlaybackMonitor = () => {
    if (playbackMonitorTimer) return;
    playbackMonitorTimer = setInterval(async () => {
        if (playbackMonitorBusy) return;
        if (!lastPlayback?.deviceHost) return;
        playbackMonitorBusy = true;
        const previousState = currentPlaybackState;
        try {
            const device = new Sonos(lastPlayback.deviceHost);
            const nextState = String(await device.getCurrentState() || 'stopped').toLowerCase();
            currentPlaybackState = nextState;
            if (nextState === 'playing' || nextState === 'paused') {
                try {
                    const track = await device.currentTrack();
                    syncPlaybackProgress(track);
                } catch (trackErr) {
                    log(`[WARN] Playback progress refresh failed: ${trackErr.message}`);
                }
            }
            if (nextState !== previousState) {
                log(`- Playback state: ${previousState} -> ${nextState}`);
            }
            if (
                playlistMode
                && previousState === 'playing'
                && nextState === 'stopped'
                && !playlistAdvanceLock
            ) {
                advancePlaylist(lastPlayback.deviceHost);
            } else if (
                currentSourceType === 'upload'
                && previousState === 'playing'
                && nextState === 'stopped'
                && !libraryAdvanceLock
            ) {
                advanceLibraryPlayback(lastPlayback.deviceHost);
            }
        } catch (err) {
            log(`[WARN] Playback monitor failed: ${err.message}`);
        } finally {
            playbackMonitorBusy = false;
        }
    }, PLAYBACK_MONITOR_INTERVAL_MS);
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

const extractVideoIdFromYoutubeUrl = (input = '') => {
    const value = String(input || '').trim();
    if (!value) return '';
    try {
        const url = new URL(value);
        if (url.hostname.includes('youtu.be')) {
            return url.pathname.replace(/^\/+/, '').split('/')[0] || '';
        }
        if (url.pathname.startsWith('/shorts/')) {
            return url.pathname.split('/')[2] || '';
        }
        return url.searchParams.get('v') || '';
    } catch (err) {
        return '';
    }
};

const normalizeYoutubeUrl = (input = '') => {
    const value = String(input || '').trim();
    if (!value) return value;
    const id = extractVideoIdFromYoutubeUrl(value);
    if (id) {
        return `https://www.youtube.com/watch?v=${id}`;
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
    currentPlaybackState = 'stopped';
    currentPlaybackPositionSec = 0;
    currentPlaybackPositionUpdatedAt = 0;
    currentSourceType = 'idle';
    currentLibraryItemId = null;
    restartAttempts = 0;
    lastPlayback = null;
    stopPlaybackMonitor();
    resetMediaState();
};

app.use(cors());
app.use(express.json());

// Logger
app.use((req, res, next) => {
    log(`[REQ] ${req.method} ${req.url}`);
    next();
});
app.use('/media', express.static(MEDIA_CACHE_DIR, {
    fallthrough: false,
    setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        if (filePath.endsWith('.mp3')) {
            res.setHeader('Content-Type', 'audio/mpeg');
        }
    }
}));
app.use('/uploads', express.static(UPLOADS_DIR, {
    fallthrough: false,
    setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        if (filePath.endsWith('.mp3')) {
            res.setHeader('Content-Type', 'audio/mpeg');
        }
    }
}));

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
    const TIMEOUT = 200; // Increased timeout for reliability

    log(`Starting network scan on 10.10.4-7.x (timeout ${TIMEOUT}ms)...`);

    for (const b of [4, 5, 6, 7]) {
        for (let i = 1; i <= 254; i++) {
            const host = `10.10.${b}.${i}`;
            scanPromises.push(new Promise((resolve) => {
                const socket = new net.Socket();
                socket.setTimeout(TIMEOUT);
                socket.on('connect', () => {
                    foundHosts.push(host);
                    log(`- Scan found potential Sonos at ${host}`);
                    socket.destroy();
                    resolve();
                });
                socket.on('timeout', () => { socket.destroy(); resolve(); });
                socket.on('error', () => { socket.destroy(); resolve(); });
                socket.connect(1400, host);
            }));
        }
    }

    await Promise.all(scanPromises);
    log(`Scan finished. Found ${foundHosts.length} potential hosts. Fetching details...`);

    const detailedDevices = await Promise.all(foundHosts.map(async (host) => {
        try {
            const device = new Sonos(host);
            // Use withRetry or at least a timeout for these UPnP calls
            const [zoneAttrs, volume] = await Promise.all([
                device.getZoneAttrs().catch(err => {
                    log(`[WARN] Failed to get ZoneAttrs for ${host}: ${err.message}`);
                    return { CurrentZoneName: `Sonos (${host})` };
                }),
                device.getVolume().catch(() => 50)
            ]);
            return { host, name: zoneAttrs.CurrentZoneName, model: 'Sonos', volume };
        } catch (e) {
            log(`[ERROR] Detail fetch failed for ${host}: ${e.message}`);
            return null;
        }
    }));

    const results = detailedDevices.filter(d => d !== null);
    log(`Scan returned ${results.length} active Sonos devices.`);
    res.json(results);
});

app.get('/library', (req, res) => {
    syncLibraryWithFiles();
    ensureLibraryDurations()
        .catch((err) => log(`[WARN] Failed to refresh library durations: ${err.message}`))
        .finally(() => {
            res.json({ items: libraryItems });
        });
});

app.post('/library/upload', uploadLibraryFiles.array('files', 24), async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
        res.status(400).send('files required');
        return;
    }
    const added = await Promise.all(files.map(async (file) => {
        const id = stripExtension(file.filename);
        const durationSec = await probeAudioDuration(path.join(UPLOADS_DIR, file.filename));
        const originalName = decodeUploadText(file.originalname);
        return {
            id,
            title: sanitizeLibraryTitle(originalName),
            originalName,
            storedName: file.filename,
            mimeType: file.mimetype || 'application/octet-stream',
            size: file.size,
            durationSec,
            durationLabel: durationSec != null ? formatDuration(durationSec) : null,
            uploadedAt: new Date().toISOString()
        };
    }));
    libraryItems = sortLibraryItems([...added, ...libraryItems]);
    persistLibraryState();
    res.send({ items: libraryItems, added });
});

app.delete('/library/:id', async (req, res) => {
    const { id } = req.params;
    const item = libraryItems.find((entry) => entry.id === id);
    if (!item) {
        res.status(404).send('library item not found');
        return;
    }
    const filePath = getLibraryItemPath(item);
    const deletingCurrent = currentMediaFile && path.resolve(currentMediaFile) === path.resolve(filePath);
    libraryItems = libraryItems.filter((entry) => entry.id !== id);
    persistLibraryState();
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
        log(`[WARN] Failed to delete upload ${item.storedName}: ${err.message}`);
    }
    if (deletingCurrent && lastPlayback?.deviceHost) {
        try {
            const device = new Sonos(lastPlayback.deviceHost);
            await withRetry(() => device.stop(), { label: 'Stop deleted upload', attempts: 2, baseDelay: 300 });
        } catch (err) {
            log(`[WARN] Stop deleted upload failed: ${err.message}`);
        }
        resetPlaybackState();
    }
    res.send({ items: libraryItems });
});

app.post('/library/play', async (req, res) => {
    const { deviceHost, id } = req.body || {};
    if (!deviceHost || !id) {
        res.status(400).send('deviceHost and id required');
        return;
    }
    const item = libraryItems.find((entry) => entry.id === id);
    if (!item) {
        res.status(404).send('library item not found');
        return;
    }
    try {
        if (!Number.isFinite(item.durationSec) || item.durationSec <= 0) {
            const durationSec = await probeAudioDuration(getLibraryItemPath(item));
            if (durationSec != null) {
                item.durationSec = durationSec;
                item.durationLabel = formatDuration(durationSec);
                persistLibraryState();
            }
        }
        playlistMode = false;
        const { title } = await startUploadedPlayback(deviceHost, item);
        res.send({ status: 'playing', title, item });
    } catch (err) {
        if (isPlaybackSupersededError(err)) {
            log(`[WARN] Upload play superseded: ${err.message}`);
            res.status(409).send(err.message);
            return;
        }
        log(`[ERR] Upload play: ${err.message}`);
        res.status(500).send(err.message);
    }
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
    assertDependenciesAvailable('yt-dlp', 'ffmpeg');
    const startToken = ++playbackStartToken;
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
    const fallbackTitle = typeof fallbackMeta?.title === 'string' ? fallbackMeta.title.trim() : '';
    const fallbackDurationSec = Number.isFinite(fallbackMeta?.durationSec) ? Number(fallbackMeta.durationSec) : null;
    const fallbackDurationLabel = typeof fallbackMeta?.durationLabel === 'string' ? fallbackMeta.durationLabel.trim() : '';
    const fallbackVideoId = extractVideoIdFromYoutubeUrl(normalizedUrl);
    let title = fallbackTitle || (fallbackVideoId ? `YouTube: ${fallbackVideoId}` : 'Sonons Audio');
    let art = '';
    let durationSec = fallbackDurationSec;
    let durationLabel = fallbackDurationLabel || (durationSec != null ? formatDuration(durationSec) : null);
    let metadataProbeFailed = false;
    const probeMetadata = async (timeoutMs) => {
        const args = ['--no-config', '--no-warnings', '--no-playlist'];
        if (YT_COOKIES) args.push('--cookies', YT_COOKIES);
        if (YT_JS_RUNTIME) args.push('--js-runtimes', YT_JS_RUNTIME);
        if (YT_FORCE_IPV4) args.push('-4');
        args.push(
            '--extractor-args', YT_EXTRACTOR_ARGS,
            '--user-agent', YT_USER_AGENT,
            '--print', '%(title)s',
            '--print', '%(thumbnail)s',
            '--print', '%(duration)s',
            '--print', '%(duration_string)s',
            normalizedUrl
        );
        const { stdout } = await execBinary('yt-dlp', args, {
            maxBuffer: 1024 * 1024,
            timeout: timeoutMs
        });
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

    if (metadataProbeFailed && (!fallbackTitle || isGenericPlaybackTitle(title))) {
        void resolveTitleFallback(normalizedUrl).then((resolved) => {
            if (!resolved) return;
            if (startToken !== playbackStartToken) return;
            title = resolved.title;
            log(`- Metadata title refreshed via ${resolved.source}`);
        });
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

    const mediaToken = crypto.randomUUID();
    const downloadedFile = await downloadAudioFile(normalizedUrl, mediaToken);
    assertStillLatest();
    resetMediaState({ keepPaths: [downloadedFile] });
    currentMediaFile = downloadedFile;
    currentMediaToken = mediaToken;
    currentYoutubeUrl = normalizedUrl;
    currentTitle = title;
    currentDurationSec = durationSec;
    currentDurationLabel = durationLabel;
    currentDirectUrl = '';
    currentDirectUrlAt = 0;
    currentDirectUrlFor = '';
    currentDirectUrlPromise = null;
    currentDirectUrlPromiseFor = '';
    currentPlaybackPositionSec = 0;
    currentPlaybackPositionUpdatedAt = Date.now();

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
    currentPlaybackState = 'stopped';
    activeStreamCount = 0;

    const normalizedTitle = truncate(normalizeTitle(currentTitle), 120);
    const asciiTitle = truncate(toAscii(currentTitle) || 'Sonons Audio', 120);
    const safeTitle = escapeXml(normalizedTitle);
    const safeAsciiTitle = escapeXml(asciiTitle);
    const mediaUri = `http://${HOST_IP}:${PORT}/media/${currentMediaToken}.mp3`;

    log(`- Title: ${currentTitle}`);
    log(`- Downloaded media: ${downloadedFile}`);
    log(`- Primary URI: ${mediaUri}`);

    const buildMetadata = (titleValue) =>
        `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="-1" parentID="-1" restricted="1"><dc:title>${titleValue}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON65031_</desc></item></DIDL-Lite>`;

    const candidates = [
        { label: 'http file + meta', uri: mediaUri, metadata: buildMetadata(safeTitle) },
        { label: 'http file + ascii-meta', uri: mediaUri, metadata: buildMetadata(safeAsciiTitle) },
        { label: 'http file + empty', uri: mediaUri, metadata: '' }
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
            currentPlaybackState = 'playing';
            currentPlaybackPositionSec = 0;
            currentPlaybackPositionUpdatedAt = Date.now();
            activeStreamCount = 1;
            restartAttempts = 0;
            if (restartTimer) {
                clearTimeout(restartTimer);
                restartTimer = null;
            }
            startPlaybackMonitor();
            return { title: currentTitle, art };
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
const startUploadedPlayback = async (deviceHost, item) => {
    const startToken = ++playbackStartToken;
    const assertStillLatest = () => {
        if (startToken !== playbackStartToken) {
            throw createPlaybackSupersededError();
        }
    };
    const filePath = getLibraryItemPath(item);
    if (!fs.existsSync(filePath)) {
        throw new Error('Uploaded file is missing on disk');
    }
    const title = item.title || sanitizeLibraryTitle(item.originalName);
    currentMediaFile = filePath;
    currentMediaToken = item.id;
    currentYoutubeUrl = '';
    currentTitle = title;
    currentDurationSec = Number.isFinite(item.durationSec) ? item.durationSec : null;
    currentDurationLabel = item.durationLabel || (currentDurationSec != null ? formatDuration(currentDurationSec) : null);
    currentSourceType = 'upload';
    currentLibraryItemId = item.id;
    currentDirectUrl = '';
    currentDirectUrlAt = 0;
    currentDirectUrlFor = '';
    currentDirectUrlPromise = null;
    currentDirectUrlPromiseFor = '';
    currentPlaybackPositionSec = 0;
    currentPlaybackPositionUpdatedAt = Date.now();

    const coordinatorHost = await resolveCoordinatorHost(deviceHost);
    assertStillLatest();
    const device = new Sonos(coordinatorHost);
    try {
        await withRetry(() => device.stop(), { label: 'Preflight stop', attempts: 2, baseDelay: 300 });
    } catch (err) {
        log(`[WARN] Preflight stop failed: ${err.message}`);
    }
    assertStillLatest();
    currentPlaybackState = 'stopped';
    activeStreamCount = 0;

    const normalizedTitle = truncate(normalizeTitle(currentTitle), 120);
    const asciiTitle = truncate(toAscii(currentTitle) || 'Uploaded Track', 120);
    const safeTitle = escapeXml(normalizedTitle);
    const safeAsciiTitle = escapeXml(asciiTitle);
    const mediaUri = `http://${HOST_IP}:${PORT}/uploads/${encodeURIComponent(item.storedName)}`;
    const buildMetadata = (titleValue) =>
        `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="-1" parentID="-1" restricted="1"><dc:title>${titleValue}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON65031_</desc></item></DIDL-Lite>`;
    const candidates = [
        { label: 'upload + meta', uri: mediaUri, metadata: buildMetadata(safeTitle) },
        { label: 'upload + ascii-meta', uri: mediaUri, metadata: buildMetadata(safeAsciiTitle) },
        { label: 'upload + empty', uri: mediaUri, metadata: '' }
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
            await withRetry(() => device.play(), { label: 'Play upload', attempts: 3, baseDelay: 400 });
            assertStillLatest();
            lastPlayback = {
                deviceHost: coordinatorHost,
                uri: option.uri,
                metadata: option.metadata,
                startedAt: Date.now()
            };
            currentPlaybackState = 'playing';
            currentPlaybackPositionSec = 0;
            currentPlaybackPositionUpdatedAt = Date.now();
            activeStreamCount = 1;
            restartAttempts = 0;
            if (restartTimer) {
                clearTimeout(restartTimer);
                restartTimer = null;
            }
            startPlaybackMonitor();
            log(`[SUCCESS] Uploaded file accepted: ${option.label}`);
            return { title: currentTitle };
        } catch (err) {
            if (isPlaybackSupersededError(err)) throw err;
            lastError = err;
            log(`- Failed: ${option.label} -> ${err.message}`);
        }
    }
    throw lastError || new Error('All upload playback candidates failed');
};

// Play (YouTube)
app.post('/play', async (req, res) => {
    const { deviceHost, youtubeUrl } = req.body;
    try {
        playlistMode = false;
        currentSourceType = 'idle';
        currentLibraryItemId = null;
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
        currentPlaybackState = 'paused';
        currentPlaybackPositionUpdatedAt = Date.now();
        activeStreamCount = 0;
        restartAttempts = 0;
        lastPlayback = null;
        stopPlaybackMonitor();
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
    const positionSec = getEffectivePlaybackPositionSec();
    res.json({
        title: currentTitle || null,
        youtubeUrl: currentYoutubeUrl || null,
        isPlaying: currentPlaybackState === 'playing',
        activeStreams: currentPlaybackState === 'playing' ? 1 : 0,
        playbackState: currentPlaybackState,
        sourceType: currentSourceType,
        libraryItemId: currentLibraryItemId,
        startedAt: lastPlayback?.startedAt || null,
        positionSec,
        positionUpdatedAt: currentPlaybackPositionUpdatedAt || null,
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

app.get('/sonons.mp3', (req, res) => {
    if (!currentMediaFile || !fs.existsSync(currentMediaFile)) {
        res.status(404).send('No downloaded media');
        return;
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(currentMediaFile);
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
