const express = require('express');
const { Sonos, AsyncDeviceDiscovery } = require('sonos');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
const PORT = 3005;
const HOST_IP = '10.10.4.213';
const VERSION = '8.0 (Clean URI)';

// STORE STATE LOCALLY
// This allows us to give Sonos a clean URL without messy query params
let currentYoutubeUrl = '';
let currentTitle = 'Sonons Stream';
let lastPlayback = null;
let restartTimer = null;
let restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_WINDOW_MS = 20000;
let currentDirectUrl = '';
let currentDirectUrlAt = 0;
const DIRECT_URL_TTL_MS = 5 * 60 * 1000;

const logs = [];
const log = (msg) => {
    const line = `[v${VERSION}] ${new Date().toLocaleTimeString()} | ${msg}`;
    console.log(line);
    logs.push(line);
    if (logs.length > 100) logs.shift();
};
const isEpipe = (err) =>
    !!err && (err.code === 'EPIPE' || String(err.message || '').includes('EPIPE'));
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
            await device.setAVTransportURI({ uri: lastPlayback.uri, metadata: lastPlayback.metadata, onlySetUri: true });
            await device.play();
        } catch (err) {
            log(`[WARN] Auto-restart failed: ${err.message}`);
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

log(`BOOT: Starting Sonons v${VERSION}...`);

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
            await masterDevice.becomeCoordinatorOfStandaloneGroup();
        } catch (err) {
            log(`[WARN] Master leave group failed: ${err.message}`);
        }

        const members = memberHosts.filter((host) => host && host !== masterHost);
        for (const host of members) {
            try {
                const memberDevice = new Sonos(host);
                await memberDevice.joinGroup(masterName);
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

// Play (YouTube)
app.post('/play', async (req, res) => {
    const { deviceHost, youtubeUrl } = req.body;
    log(`SETUP CLEAN PLAY: ${youtubeUrl} on ${deviceHost}`);

    try {
        // 1. UPDATE STATE
        currentYoutubeUrl = youtubeUrl;
        currentDirectUrl = '';
        currentDirectUrlAt = 0;

        const coordinatorHost = await resolveCoordinatorHost(deviceHost);
        if (coordinatorHost !== deviceHost) {
            log(`- Coordinator resolved: ${deviceHost} -> ${coordinatorHost}`);
        }
        const device = new Sonos(coordinatorHost);
        const ytExtractorArgs = 'youtube:player_client=android,web';
        const ytUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        const { stdout } = await execPromise(
            `yt-dlp --no-warnings --no-playlist --extractor-args "${ytExtractorArgs}" --user-agent "${ytUserAgent}" --print "%(title)s" --print "%(thumbnail)s" "${youtubeUrl}"`,
            { maxBuffer: 1024 * 1024 }
        );
        const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const title = lines[0] || 'Sonons Audio';
        const art = lines[1] || '';

        currentTitle = title;
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
                await device.setAVTransportURI({ uri: option.uri, metadata: option.metadata, onlySetUri: true });
                log(`- Starting playback...`);
                await device.play();
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
                res.send({ status: 'playing', title });
                return;
            } catch (err) {
                lastError = err;
                log(`- Failed: ${option.label} -> ${err.message}`);
            }
        }

        throw lastError || new Error('All AVTransport candidates failed');

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

// THE CLEAN ENDPOINT
app.get('/sonons.mp3', async (req, res) => {
    log(`SPEAKER CONNECTED to /sonons.mp3`);

    if (!currentYoutubeUrl) {
        log('No active URL set, closing connection.');
        res.end();
        return;
    }

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

    const ytExtractorArgs = 'youtube:player_client=android,web';
    const ytUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    let directUrl;
    try {
        directUrl = await resolveDirectUrl(currentYoutubeUrl, ytExtractorArgs, ytUserAgent);
        log(`- Direct URL resolved`);
    } catch (err) {
        log(`[ERR] Direct URL failed: ${err.message}`);
        res.end();
        return;
    }

    const ffArgs = [
        '-hide_banner',
        '-loglevel', 'error',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-reconnect_at_eof', '1',
        '-user_agent', ytUserAgent,
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
    ];
    const ff = spawn('ffmpeg', ffArgs);

    let ffErr = '';
    ff.stderr.on('data', (chunk) => {
        if (ffErr.length < 2000) ffErr += chunk.toString();
    });

    ff.stdout.pipe(res);

    req.on('close', () => {
        log(`STREAM CLOSED.`);
        ff.kill();
        scheduleRestart('client closed');
    });

    res.on('error', (e) => {
        if (isEpipe(e)) {
            log(`STREAM EPIPE (client closed).`);
            ff.kill();
            scheduleRestart('epipe');
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
