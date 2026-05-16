import { Injectable, Logger } from '@nestjs/common';
import { TrackEntity } from '../track/track.entity';
import { EnvironmentEnum } from '../environmentEnum';
import { TrackService } from '../track/track.service';
import { ConfigService } from '@nestjs/config';
import { YtDlp } from 'ytdlp-nodejs';
import * as fs from 'fs';
import { spawn } from 'child_process';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeID3 = require('node-id3');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MusicTempo = require('music-tempo');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

@Injectable()
export class YoutubeService {
  private readonly logger = new Logger(TrackService.name);

  constructor(private readonly configService: ConfigService) {}

  async findOnYoutubeOne(artist: string, name: string, expectedDuration?: number): Promise<string> {
    this.logger.debug(`Searching ${artist} - ${name} on YT`);
    const ytdlp = new YtDlp();
    const info = await ytdlp.getInfoAsync(`ytsearch5:${artist} - ${name}`, {
      ...this.getCookiesOptions(),
      flatPlaylist: true,
    } as any) as any;

    const entries: any[] = info?.entries ?? [];
    this.logger.debug(`Search results for ${artist} - ${name}: ${entries.map((e) => `${e.channel || e.uploader}(${e.duration}s)`).join(', ')}`);

    const scored = entries.map((e) => {
      const isTopic = e.channel?.endsWith('- Topic') || e.uploader?.endsWith('- Topic');
      const durationDiff = expectedDuration && e.duration
        ? Math.abs(e.duration - expectedDuration)
        : 9999;
      return { e, isTopic, durationDiff };
    });

    // Prefer Topic channel within 30s of expected duration, then closest duration overall
    const topicMatch = scored.filter((s) => s.isTopic && s.durationDiff <= 30)
      .sort((a, b) => a.durationDiff - b.durationDiff)[0];
    const closestDuration = expectedDuration
      ? scored.sort((a, b) => a.durationDiff - b.durationDiff)[0]
      : null;
    const chosen = (topicMatch ?? closestDuration ?? scored[0])?.e;

    const rawUrl = chosen?.webpage_url ?? chosen?.url;
    const url = rawUrl?.startsWith('http') ? rawUrl : `https://www.youtube.com/watch?v=${chosen?.id ?? rawUrl}`;
    this.logger.debug(`Found ${artist} - ${name} on ${url} [diff=${closestDuration?.durationDiff}s topic=${!!topicMatch}]`);
    return url;
  }

  private getCookiesOptions(): {
    cookiesFromBrowser?: string;
    cookies?: string;
  } {
    const cookiesBrowser = this.configService.get<string>(
      EnvironmentEnum.YT_COOKIES,
    );
    if (cookiesBrowser) {
      this.logger.debug(`Using cookies from browser: ${cookiesBrowser}`);
      return { cookiesFromBrowser: cookiesBrowser };
    }
    const cookiesFile = this.configService.get<string>(
      EnvironmentEnum.YT_COOKIES_FILE,
    );
    if (cookiesFile && fs.existsSync(cookiesFile)) {
      this.logger.debug(`Using cookies file: ${cookiesFile}`);
      return { cookies: cookiesFile };
    }
    return {};
  }

  async downloadAndFormat(track: TrackEntity, output: string): Promise<void> {
    this.logger.debug(
      `Downloading ${track.artist} - ${track.name} (${track.youtubeUrl}) from YT`,
    );
    if (!track.youtubeUrl) {
      this.logger.error('youtubeUrl is null or undefined');
      throw Error('youtubeUrl is null or undefined');
    }
    const ytdlp = new YtDlp();
    await ytdlp.downloadAudio(
      track.youtubeUrl,
      this.configService.get<'m4a'>(EnvironmentEnum.FORMAT),
      {
        output,
        ...this.getCookiesOptions(),
        headers: HEADERS,
        jsRuntime: 'node',
        audioQuality: this.configService.get<string>('QUALITY'),
      },
    );
    this.logger.debug(
      `Downloaded ${track.artist} - ${track.name} to ${output}`,
    );
  }

  async detectBpm(filePath: string): Promise<number | undefined> {
    try {
      const pcmBuffer = await this.decodeToPcm(filePath);
      const floatArray = new Float32Array(
        pcmBuffer.buffer,
        pcmBuffer.byteOffset,
        pcmBuffer.byteLength / 4,
      );
      const mt = new MusicTempo(floatArray);
      const bpm = Math.round(mt.tempo);
      this.logger.debug(`BPM detected: ${bpm} for ${filePath}`);
      return bpm;
    } catch (err) {
      this.logger.warn(`BPM detection failed: ${err.message}`);
      return undefined;
    }
  }

  private decodeToPcm(filePath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const proc = spawn('ffmpeg', [
        '-i', filePath,
        '-f', 'f32le',
        '-acodec', 'pcm_f32le',
        '-ar', '22050',
        '-ac', '1',
        'pipe:1',
      ]);
      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      proc.stderr.on('data', () => {});
      proc.on('close', (code: number) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });
      proc.on('error', reject);
    });
  }

  updateBpmTag(filePath: string, bpm: number): void {
    NodeID3.update({ bpm: String(bpm) }, filePath);
  }

  async addMetadata(
    filePath: string,
    meta: { title: string; artist: string; album?: string; year?: string; trackNumber?: number; coverUrl?: string },
  ): Promise<void> {
    const tags: Record<string, any> = {
      title: meta.title,
      artist: meta.artist,
      ...(meta.album ? { album: meta.album } : {}),
      ...(meta.year ? { year: meta.year } : {}),
      ...(meta.trackNumber ? { trackNumber: String(meta.trackNumber) } : {}),
    };

    if (meta.coverUrl) {
      try {
        const res = await fetch(meta.coverUrl);
        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          tags.APIC = {
            mime: 'image/jpeg',
            type: { id: 3, name: 'front cover' },
            description: 'cover',
            imageBuffer: Buffer.from(arrayBuf),
          };
        }
      } catch {
        this.logger.warn(`Failed to fetch cover: ${meta.coverUrl}`);
      }
    }

    NodeID3.write(tags, filePath);
  }
}
