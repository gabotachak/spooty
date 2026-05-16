export interface Track {
  id: number;
  artist: string;
  name: string;
  spotifyUrl: string;
  youtubeUrl: string;
  status: TrackStatusEnum;
  playlistId?: number;
  error?: string;
  coverUrl?: string;
  bpm?: number;
}

export enum TrackStatusEnum {
  New,
  Searching,
  Queued,
  Downloading,
  Completed,
  Error,
  CompletedBpm,
}
