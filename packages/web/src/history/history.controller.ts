import { Body, Controller, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { HistoryService } from './history.service';
import { JsonContentTypeGuard } from './json-content-type.guard';

@Controller('history')
export class HistoryController {
  constructor(private readonly historyService: HistoryService) {}

  @Get('config')
  getConfig() {
    return this.historyService.getConfig();
  }

  @Put('config')
  @UseGuards(JsonContentTypeGuard)
  setConfig(@Body() body: unknown) {
    return this.historyService.setConfig(body);
  }

  @Get('status')
  getStatus() {
    return this.historyService.getStatus();
  }

  @Post('query')
  @HttpCode(200)
  @UseGuards(JsonContentTypeGuard)
  query(@Body() body: unknown) {
    return this.historyService.query(body);
  }

  @Post('clear')
  @HttpCode(200)
  @UseGuards(JsonContentTypeGuard)
  clear() {
    return this.historyService.clear();
  }
}
