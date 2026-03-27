export interface Device {
    host: string;
    port: number;
    name: string;
    model: string;
    volume: number;
}

export interface LibraryTrack {
    id: string;
    title: string;
    originalName: string;
    storedName: string;
    mimeType: string;
    size: number;
    durationSec: number | null;
    durationLabel: string | null;
    uploadedAt: string;
}

export interface PlaybackStatus {
    title: string | null;
    isPlaying: boolean;
    activeStreams: number;
    startedAt: number | null;
    positionSec: number | null;
    positionUpdatedAt: number | null;
    durationSec: number | null;
    durationLabel: string | null;
    playbackState?: string | null;
    sourceType?: string | null;
    libraryItemId?: string | null;
    autoStopTime?: string | null;
    autoShutdownTime?: string | null;
}
