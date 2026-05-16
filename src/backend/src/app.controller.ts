import { Controller, Get, Query, Redirect, Res } from '@nestjs/common';
import { Response } from 'express';
import { SpotifyApiService } from './shared/spotify-api.service';

@Controller()
export class AppController {
  constructor(private readonly spotifyApiService: SpotifyApiService) {}

  @Get()
  getHello(): string {
    return 'ONLINE';
  }

  @Get('spotify/auth')
  @Redirect()
  spotifyAuth() {
    return { url: this.spotifyApiService.getAuthUrl() };
  }

  @Get('callback')
  async spotifyCallback(@Query('code') code: string, @Res() res: Response) {
    if (!code) {
      return res.redirect('/?spotify_error=no_code');
    }
    try {
      await this.spotifyApiService.handleOAuthCallback(code);
      return res.redirect('/?spotify_connected=1');
    } catch (err) {
      return res.redirect(`/?spotify_error=${encodeURIComponent(err.message)}`);
    }
  }

  @Get('spotify/status')
  spotifyStatus() {
    return { connected: this.spotifyApiService.hasUserToken() };
  }
}
