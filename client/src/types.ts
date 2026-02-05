export interface Device {
    host: string;
    port: number;
    name: string;
    model: string;
    volume: number;
}

export type LoopMode = 'all' | 'single' | 'shuffle';

export interface PlaylistTrack {
    uid: string;
    id: string;
    url: string;
    title: string;
    durationSec: number | null;
    durationLabel: string | null;
}
