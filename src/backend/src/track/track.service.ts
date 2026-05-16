import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TrackEntity, TrackStatusEnum } from './track.entity';
import { PlaylistEntity } from '../playlist/playlist.entity';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'path';
import { rename } from 'fs/promises';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { EnvironmentEnum } from '../environmentEnum';
import { UtilsService } from '../shared/utils.service';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { YoutubeService } from '../shared/youtube.service';

enum WsTrackOperation {
  New = 'trackNew',
  Update = 'trackUpdate',
  Delete = 'trackDelete',
}

@WebSocketGateway()
@Injectable()
export class TrackService {
  @WebSocketServer() io: Server;
  private readonly logger = new Logger(TrackService.name);

  constructor(
    @InjectRepository(TrackEntity)
    private repository: Repository<TrackEntity>,
    @InjectQueue('track-download-processor') private trackDownloadQueue: Queue,
    @InjectQueue('track-search-processor') private trackSearchQueue: Queue,
    @InjectQueue('track-bpm-processor') private trackBpmQueue: Queue,
    private readonly configService: ConfigService,
    private readonly utilsService: UtilsService,
    private readonly youtubeService: YoutubeService,
  ) {}

  getAll(
    where?: { [key: string]: any },
    relations: Record<string, boolean> = {},
  ): Promise<TrackEntity[]> {
    return this.repository.find({ where, relations });
  }

  getAllByPlaylist(id: number): Promise<TrackEntity[]> {
    return this.repository.find({ where: { playlist: { id } } });
  }

  get(id: number): Promise<TrackEntity | null> {
    return this.repository.findOne({ where: { id }, relations: ['playlist'] });
  }

  async remove(id: number): Promise<void> {
    await this.repository.delete(id);
    this.io.emit(WsTrackOperation.Delete, { id });
  }

  async create(track: TrackEntity, playlist?: PlaylistEntity): Promise<void> {
    const savedTrack = await this.repository.save({ ...track, playlist });
    await this.trackSearchQueue.add('', savedTrack, {
      jobId: `id-${savedTrack.id}`,
    });
    this.io.emit(WsTrackOperation.New, {
      track: savedTrack,
      playlistId: playlist.id,
    });
  }

  async update(id: number, track: TrackEntity): Promise<void> {
    await this.repository.update(id, track);
    this.io.emit(WsTrackOperation.Update, track);
  }

  async retry(id: number): Promise<void> {
    const track = await this.get(id);
    await this.trackSearchQueue.add('', track, { jobId: `id-${id}` });
    await this.update(id, { ...track, status: TrackStatusEnum.New });
  }

  async findOnYoutube(track: TrackEntity): Promise<void> {
    if (!(await this.get(track.id))) {
      return;
    }
    await this.update(track.id, {
      ...track,
      status: TrackStatusEnum.Searching,
    });
    let updatedTrack: TrackEntity;
    try {
      const youtubeUrl = await this.youtubeService.findOnYoutubeOne(
        track.artist,
        track.name,
        track.duration,
      );
      updatedTrack = { ...track, youtubeUrl, status: TrackStatusEnum.Queued };
    } catch (err) {
      this.logger.error(err);
      updatedTrack = {
        ...track,
        error: String(err),
        status: TrackStatusEnum.Error,
      };
    }
    await this.trackDownloadQueue.add('', updatedTrack, {
      jobId: `id-${updatedTrack.id}`,
    });
    await this.update(track.id, updatedTrack);
  }

  async downloadFromYoutube(track: TrackEntity): Promise<void> {
    if (!(await this.get(track.id))) {
      return;
    }
    if (
      !track.name ||
      !track.artist ||
      !track.playlist
    ) {
      this.logger.error(
        `Track or playlist field is null or undefined: name=${track.name}, artist=${track.artist}, playlist=${track.playlist ? 'ok' : 'null'}`,
      );
      return;
    }
    this.logger.debug(`Track metadata: album=${track.album} year=${track.year} coverUrl=${track.coverUrl}`);
    const coverUrl = track.coverUrl || this.getYoutubeThumbnail(track.youtubeUrl) || track.playlist.coverUrl;
    if (!coverUrl) {
      this.logger.warn(
        `No cover art available for track: ${track.artist} - ${track.name}`,
      );
    }
    await this.update(track.id, {
      ...track,
      status: TrackStatusEnum.Downloading,
    });
    let error: string;
    try {
      const downloadPath = this.getFolderName(track, track.playlist);
      await this.youtubeService.downloadAndFormat(track, downloadPath);
      await this.youtubeService.addMetadata(downloadPath, {
        title: track.name,
        artist: track.artist,
        album: track.album || undefined,
        year: track.year || undefined,
        trackNumber: track.trackNumber || undefined,
        coverUrl,
      });
    } catch (err) {
      this.logger.error(err);
      error = String(err);
    }
    const updatedTrack = {
      ...track,
      status: error ? TrackStatusEnum.Error : TrackStatusEnum.Completed,
      ...(error ? { error } : {}),
    };
    await this.update(track.id, updatedTrack);
    if (!error) {
      try {
        await this.trackBpmQueue.add('', track, { jobId: `bpm-${track.id}` });
      } catch (err) {
        this.logger.warn(`Failed to enqueue BPM job for track ${track.id}: ${err.message}`);
      }
    }
  }

  async detectAndApplyBpm(track: TrackEntity): Promise<void> {
    const fullTrack = await this.get(track.id);
    if (!fullTrack) return;

    const currentPath = this.getFolderName({ ...fullTrack, bpm: undefined }, fullTrack.playlist);
    const bpm = await this.youtubeService.detectBpm(currentPath);
    if (!bpm) return;

    const newPath = this.getFolderName({ ...fullTrack, bpm }, fullTrack.playlist);
    try {
      if (currentPath !== newPath) {
        await rename(currentPath, newPath);
      }
      this.youtubeService.updateBpmTag(newPath, bpm);
    } catch (err) {
      this.logger.warn(`BPM post-processing failed for track ${fullTrack.id}: ${err.message}`);
      return;
    }
    await this.update(fullTrack.id, { ...fullTrack, bpm, status: TrackStatusEnum.CompletedBpm });
  }

  getTrackFileName(track: TrackEntity): string {
    const sanitize = (s: string) =>
      s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const artist = sanitize(track.artist || 'unknown artist');
    const name = sanitize(track.name || 'unknown track');
    const format = this.configService.get<string>(EnvironmentEnum.FORMAT);
    const bpmSuffix = track.bpm ? ` - ${track.bpm}bpm` : '';
    return `${name} - ${artist}${bpmSuffix}.${format}`;
  }

  private getYoutubeThumbnail(youtubeUrl: string): string | null {
    try {
      const match = youtubeUrl?.match(/[?&]v=([^&]+)/);
      const videoId = match?.[1];
      return videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : null;
    } catch {
      return null;
    }
  }

  getFolderName(track: TrackEntity, playlist: PlaylistEntity): string {
    // Individual tracks (isTrack=true) go in root downloads folder, playlists in subfolders
    if (playlist?.isTrack) {
      return resolve(
        this.utilsService.getRootDownloadsPath(),
        this.getTrackFileName(track),
      );
    }
    
    const safePlaylistName = playlist?.name || 'unknown_playlist';
    return resolve(
      this.utilsService.getPlaylistFolderPath(safePlaylistName),
      this.getTrackFileName(track),
    );
  }
}
