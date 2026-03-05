import { Controller, Get, Param, Query } from '@nestjs/common';
import { LogService } from './log.service';

@Controller()
export class LogController {
  constructor(private readonly logService: LogService) {}

  @Get('pods/:namespace/:pod/logs')
  getLogs(
    @Param('namespace') namespace: string,
    @Param('pod') pod: string,
    @Query('container') container?: string,
    @Query('tail') tail?: string,
    @Query('since') since?: string,
    @Query('level') level?: string,
    @Query('search') search?: string,
  ) {
    return this.logService.getParsedLogs({
      namespace,
      pod,
      container,
      tail: tail ? parseInt(tail, 10) : undefined,
      since: since ? parseInt(since, 10) : undefined,
      level,
      search,
    });
  }
}
