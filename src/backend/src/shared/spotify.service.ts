import { Injectable, Logger } from '@nestjs/common';
import { TrackService } from '../track/track.service';
import { SpotifyApiService } from './spotify-api.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fetch = require('isomorphic-unfetch');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDetails } = require('spotify-url-info')(fetch);

@Injectable()
export class SpotifyService {
  private readonly logger = new Logger(TrackService.name);

  constructor(private readonly spotifyApiService: SpotifyApiService) {}

  isTrackUrl(url: string): boolean {
    return this.spotifyApiService.isTrackUrl(url);
  }

  async getTrackDetail(
    spotifyUrl: string,
  ): Promise<{ name: string; artist: string; image: string; album?: string; year?: string; trackNumber?: number; duration?: number }> {
    this.logger.debug(`Get track ${spotifyUrl} on Spotify`);
    try {
      return await this.spotifyApiService.getTrackMetadata(spotifyUrl);
    } catch (error) {
      this.logger.error(`Error getting track details: ${error.message}`);
      const detail = await getDetails(spotifyUrl);
      return {
        name: detail.preview.title,
        artist: detail.preview.artist || 'Unknown Artist',
        image: detail.preview.image,
      };
    }
  }

  async getPlaylistDetail(
    spotifyUrl: string,
  ): Promise<{ name: string; tracks: any[]; image: string }> {
    this.logger.debug(`Get playlist ${spotifyUrl} on Spotify`);

    // Metadata and tracks fetched independently so one failure doesn't block the other
    let metadata: { name: string; image: string } | null = null;
    try {
      metadata = await this.spotifyApiService.getPlaylistMetadata(spotifyUrl);
    } catch (metaError) {
      this.logger.warn(`Playlist metadata fetch failed: ${metaError.message}`);
    }

    // Try direct Spotify API (supports unlimited tracks when OAuth connected)
    try {
      const tracks = await this.spotifyApiService.getAllPlaylistTracks(spotifyUrl);
      this.logger.debug(`Direct API returned ${tracks.length} tracks`);

      if (metadata) {
        return { name: metadata.name, tracks, image: metadata.image };
      }
      // metadata failed — get name/image from spotify-url-info only
      const detail = await getDetails(spotifyUrl);
      return { name: detail.preview.title, tracks, image: detail.preview.image };
    } catch (tracksError) {
      this.logger.warn(`Direct API track fetch failed (${tracksError.message}), falling back to spotify-url-info (100-track limit)`);
    }

    // Full fallback — capped at ~100 tracks
    const detail = await getDetails(spotifyUrl);
    const rawTracks = detail?.tracks ?? [];
    const tracks = await Promise.all(
      rawTracks.map(async (t: any) => {
        if (!t.artist || !t.name) return t;
        const meta = await this.spotifyApiService.searchTrackMetadata(t.artist, t.name);
        return { ...t, ...meta };
      }),
    );
    return {
      name: metadata?.name ?? detail.preview.title,
      tracks,
      image: metadata?.image ?? detail.preview.image,
    };
  }

  async getPlaylistTracks(spotifyUrl: string): Promise<any[]> {
    this.logger.debug(`Get playlist ${spotifyUrl} on Spotify`);
    try {
      return await this.spotifyApiService.getAllPlaylistTracks(spotifyUrl);
    } catch (error) {
      this.logger.error(`Error getting playlist tracks: ${error.message}`);
      return (await getDetails(spotifyUrl)?.tracks) ?? [];
    }
  }
}
