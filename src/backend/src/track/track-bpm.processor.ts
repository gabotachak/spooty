import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { TrackService } from './track.service';
import { TrackEntity } from './track.entity';

@Processor('track-bpm-processor', { concurrency: 8 })
export class TrackBpmProcessor extends WorkerHost {
  constructor(private readonly trackService: TrackService) {
    super();
  }

  async process(job: Job<TrackEntity, void>): Promise<void> {
    await this.trackService.detectAndApplyBpm(job.data);
  }
}
