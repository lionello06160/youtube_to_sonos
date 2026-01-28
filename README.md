# Sonons

Sonons is a local web UI + Node server for streaming YouTube audio to Sonos speakers. The server fetches audio with `yt-dlp`, transcodes to MP3 with `ffmpeg`, and exposes a clean stream URL that Sonos can play.

## Architecture

- **Client**: Vite + React UI (device discovery, grouping, playback, volume)
- **Server**: Express + node-sonos + yt-dlp + ffmpeg
- **Flow**: UI -> `/play` -> Sonos `SetAVTransportURI` -> Sonos fetches `/sonons.mp3` -> `yt-dlp | ffmpeg` streaming

## Requirements

- Node.js (18+ recommended)
- `yt-dlp` installed and available in `$PATH`
- `ffmpeg` installed and available in `$PATH`
- Sonos devices on the same LAN as the server

macOS (Homebrew):

```bash
brew install yt-dlp ffmpeg
```

## Configuration

Update these two values to match your network:

- **Server stream IP**: `server/index.js` -> `HOST_IP`
  - Must be the IP Sonos can reach (e.g., your Mac’s LAN IP)
- **Client API URL**: `client/src/App.tsx` -> `API_URL`
  - Should point to the server, e.g. `http://10.10.4.213:3005`

Default server port is `3005`.

## Install

```bash
# Server
cd server
npm install

# Client
cd ../client
npm install
```

## Run

```bash
# Terminal 1
cd server
npm start

# Terminal 2
cd client
npm run dev
```

Open the UI at:

```
http://localhost:5173
```

## Usage

1. Click **Scan** or **Deep Scan** to discover Sonos devices.
2. Select one or more devices.
3. Paste a YouTube URL and click **Broadcast**.
4. Adjust volume from the device cards.

## API Endpoints

- `GET /check` – health check
- `GET /devices` – Sonos discovery (quick)
- `GET /scan` – deep scan across `10.10.x.x`
- `POST /group` – group devices (optional)
- `POST /play` – start playback from YouTube URL
- `POST /volume` – set volume
- `GET /sonons.mp3` – clean stream endpoint for Sonos
- `GET /logs` – recent server log output

Note: the client has a “manual IP” UI, but `/add-device` is not implemented in the server.

## Troubleshooting

- **No sound / stream closes immediately**
  - Check `/logs` for `YT Exit` or `FF Exit` errors.
  - Confirm Sonos can reach `http://<HOST_IP>:3005/sonons.mp3` from another device on the LAN.

- **YouTube errors (403 / format not available)**
  - Update `yt-dlp` to latest.
  - Some videos require cookies or different extractor settings.

- **UPnP 1023 errors**
  - Usually means the command was sent to a non-coordinator device.
  - The server resolves coordinators automatically; if still failing, group devices in the Sonos app first.

## Notes

- Streaming uses on-the-fly transcoding to MP3 (`ffmpeg`), which is CPU-intensive.
- YouTube “radio” URLs can be unstable; regular video URLs are more reliable.
