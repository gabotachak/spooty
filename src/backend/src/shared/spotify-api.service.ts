import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fetch = require('isomorphic-unfetch');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDetails } = require('spotify-url-info')(fetch);

@Injectable()
export class SpotifyApiService implements OnModuleInit {
  private readonly logger = new Logger(SpotifyApiService.name);
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private userAccessToken: string | null = null;
  private userTokenExpiry: number = 0;
  private userRefreshToken: string | null = null;

  constructor() {}

  async onModuleInit(): Promise<void> {
    await this.loadTokensFromFile();
  }

  private getTokenFilePath(): string {
    const dbPath = process.env.DB_PATH || './config/db.sqlite';
    return path.join(path.dirname(dbPath), 'spotify_tokens.json');
  }

  private async loadTokensFromFile(): Promise<void> {
    try {
      const filePath = this.getTokenFilePath();
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        this.userAccessToken = data.accessToken || null;
        this.userTokenExpiry = data.tokenExpiry || 0;
        this.userRefreshToken = data.refreshToken || null;
        this.logger.debug('Loaded Spotify OAuth tokens from file');
      }
    } catch (err) {
      this.logger.warn(`Failed to load Spotify tokens: ${err.message}`);
    }
  }

  private saveTokensToFile(): void {
    try {
      const filePath = this.getTokenFilePath();
      fs.writeFileSync(filePath, JSON.stringify({
        accessToken: this.userAccessToken,
        tokenExpiry: this.userTokenExpiry,
        refreshToken: this.userRefreshToken,
      }));
    } catch (err) {
      this.logger.warn(`Failed to save Spotify tokens: ${err.message}`);
    }
  }

  hasUserToken(): boolean {
    return !!(this.userAccessToken || this.userRefreshToken);
  }

  getAuthUrl(): string {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3000/api/callback';
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'playlist-read-private playlist-read-collaborative',
    });
    return `https://accounts.spotify.com/authorize?${params.toString()}`;
  }

  async handleOAuthCallback(code: string): Promise<void> {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3000/api/callback';
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`OAuth token exchange failed: ${errorData}`);
    }

    const data = await response.json();
    this.userAccessToken = data.access_token;
    this.userRefreshToken = data.refresh_token;
    this.userTokenExpiry = Date.now() + data.expires_in * 1000 - 60000;
    this.saveTokensToFile();
    this.logger.debug('Successfully obtained Spotify OAuth tokens');
  }

  private async getUserAccessToken(): Promise<string> {
    if (this.userAccessToken && Date.now() < this.userTokenExpiry) {
      return this.userAccessToken;
    }
    if (this.userRefreshToken) {
      return this.refreshUserToken();
    }
    throw new Error('No Spotify user token available — connect via /api/spotify/auth');
  }

  private async refreshUserToken(): Promise<string> {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.userRefreshToken,
      }).toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${errorText}`);
    }

    const data = await response.json();
    this.userAccessToken = data.access_token;
    this.userTokenExpiry = Date.now() + data.expires_in * 1000 - 60000;
    if (data.refresh_token) {
      this.userRefreshToken = data.refresh_token;
    }
    this.saveTokensToFile();
    this.logger.debug('Refreshed Spotify OAuth token');
    return this.userAccessToken;
  }

  private getPlaylistId(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/');
      const playlistIndex = pathParts.findIndex((part) => part === 'playlist');
      if (playlistIndex >= 0 && pathParts.length > playlistIndex + 1) {
        return pathParts[playlistIndex + 1].split('?')[0];
      }
      throw new Error('Invalid Spotify playlist URL');
    } catch (error) {
      this.logger.error(`Failed to extract playlist ID: ${error.message}`);
      throw error;
    }
  }

  isTrackUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return urlObj.pathname.includes('/track/');
    } catch {
      return false;
    }
  }

  private getTrackId(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/');
      const trackIndex = pathParts.findIndex((part) => part === 'track');
      if (trackIndex >= 0 && pathParts.length > trackIndex + 1) {
        return pathParts[trackIndex + 1].split('?')[0];
      }
      throw new Error('Invalid Spotify track URL');
    } catch (error) {
      this.logger.error(`Failed to extract track ID: ${error.message}`);
      throw error;
    }
  }

  async getTrackMetadata(
    spotifyUrl: string,
  ): Promise<{ name: string; artist: string; image: string; album: string; year: string; trackNumber: number; duration: number }> {
    try {
      this.logger.debug(`Getting track metadata for ${spotifyUrl}`);
      const trackId = this.getTrackId(spotifyUrl);
      const accessToken = await this.getAccessToken();

      const response = await fetch(
        `https://api.spotify.com/v1/tracks/${trackId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch track: ${response.status}`);
      }

      const data = await response.json();

      return {
        name: data.name,
        artist: data.artists.map((a: any) => a.name).join(', '),
        image: data.album.images[0]?.url || '',
        album: data.album.name || '',
        year: data.album.release_date?.substring(0, 4) || '',
        trackNumber: data.track_number || 0,
        duration: data.duration_ms ? Math.round(data.duration_ms / 1000) : null,
      };
    } catch (error) {
      this.logger.error(`Failed to get track metadata: ${error.message}`);
      throw error;
    }
  }

  async getPlaylistMetadata(
    spotifyUrl: string,
  ): Promise<{ name: string; image: string }> {
    try {
      this.logger.debug(`Getting playlist metadata for ${spotifyUrl}`);
      const detail = await getDetails(spotifyUrl);

      return {
        name: detail.preview.title,
        image: detail.preview.image,
      };
    } catch (error) {
      this.logger.error(`Failed to get playlist metadata: ${error.message}`);
      throw error;
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      this.logger.debug('Getting new Spotify access token');

      const clientId = process.env.SPOTIFY_CLIENT_ID;
      const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        throw new Error(
          'Missing Spotify credentials. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env file',
        );
      }

      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
        'base64',
      );

      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Failed to get access token: ${errorData}`);
      }

      const data = await response.json();
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + data.expires_in * 1000 - 60000;

      this.logger.debug('Successfully obtained Spotify access token');
      return this.accessToken;
    } catch (error) {
      this.logger.error(`Error getting Spotify access token: ${error.message}`);
      throw error;
    }
  }

  async getAllPlaylistTracks(spotifyUrl: string): Promise<any[]> {
    try {
      this.logger.debug(`Getting all tracks for playlist ${spotifyUrl}`);

      const playlistId = this.getPlaylistId(spotifyUrl);
      this.logger.debug(`Extracted playlist ID: ${playlistId}`);

      const usingUserToken = this.hasUserToken();
      this.logger.debug(`getAllPlaylistTracks: using ${usingUserToken ? 'user OAuth' : 'client credentials'} token`);
      const accessToken = usingUserToken
        ? await this.getUserAccessToken()
        : await this.getAccessToken();

      const allTracks = [];
      let nextUrl: string | null =
        `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;

      while (nextUrl) {
        this.logger.debug(`Fetching tracks from ${nextUrl}`);

        const response = await fetch(nextUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        this.logger.debug(`Spotify tracks API response: ${response.status}`);
        if (!response.ok) {
          const errorText = await response.text();
          this.logger.error(`Spotify API error: ${response.status} ${errorText}`);
          throw new Error(`Failed to fetch tracks: ${response.status} — ${usingUserToken ? 'user token' : 'client credentials'}`);
        }

        const data = await response.json();

        if (!data.items || data.items.length === 0) {
          this.logger.debug('No more tracks to fetch from Spotify API');
          break;
        }

        const pageTracks = data.items
          .map(
            (item: {
              track: {
                id: string;
                name: any;
                artists: any[];
                preview_url: any;
                track_number: number;
                album: { images: any[]; name: string; release_date: string };
              };
            }) => {
              if (!item.track) return null;

              return {
                id: item.track.id,
                name: item.track.name,
                artist: item.track.artists.map((a: any) => a.name).join(', '),
                previewUrl: item.track.preview_url,
                coverUrl: item.track.album?.images?.[0]?.url || null,
                album: item.track.album?.name || null,
                year: item.track.album?.release_date?.substring(0, 4) || null,
                trackNumber: item.track.track_number || null,
              };
            },
          )
          .filter((track) => track !== null);

        this.logger.debug(
          `Retrieved ${pageTracks.length} tracks (total so far: ${allTracks.length + pageTracks.length})`,
        );

        if (pageTracks.length > 0) {
          allTracks.push(...pageTracks);
        }

        nextUrl = data.next ?? null;
      }

      this.logger.debug(
        `Total tracks retrieved from Spotify API: ${allTracks.length}`,
      );
      return allTracks;
    } catch (error) {
      this.logger.error(`Failed to get all playlist tracks: ${error.message}`);
      throw error;
    }
  }

  async searchTrackMetadata(
    artist: string,
    name: string,
  ): Promise<{ coverUrl: string; album: string; year: string; trackNumber: number; duration: number } | null> {
    try {
      const accessToken = await this.getAccessToken();
      const q = encodeURIComponent(`track:${name} artist:${artist}`);
      const response = await fetch(
        `https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!response.ok) {
        this.logger.warn(`searchTrackMetadata ${artist} - ${name}: HTTP ${response.status}`);
        return null;
      }
      const data = await response.json();
      const track = data.tracks?.items?.[0];
      if (!track) {
        this.logger.warn(`searchTrackMetadata ${artist} - ${name}: no results`);
        return null;
      }
      const result = {
        coverUrl: track.album?.images?.[0]?.url || null,
        album: track.album?.name || null,
        year: track.album?.release_date?.substring(0, 4) || null,
        trackNumber: track.track_number || null,
        duration: track.duration_ms ? Math.round(track.duration_ms / 1000) : null,
      };
      this.logger.debug(`searchTrackMetadata ${artist} - ${name}: album=${result.album} year=${result.year}`);
      return result;
    } catch (err) {
      this.logger.warn(`searchTrackMetadata ${artist} - ${name}: ${err.message}`);
      return null;
    }
  }
}
