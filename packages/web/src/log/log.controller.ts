import { Controller, Get, Param, Query, BadRequestException } from '@nestjs/common';
import { LogService } from './log.service';

const VALID_LEVELS = new Set(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);
const MAX_TAIL = 10000;
const MAX_LIMIT = 10000;

function parsePositiveInt(value: string | undefined, name: string, max?: number): number | undefined {
  if (value == null) return undefined;
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0) {
    throw new BadRequestException(`${name} debe ser un número entero positivo`);
  }
  return max != null ? Math.min(n, max) : n;
}

@Controller()
export class LogController {
  constructor(private readonly logService: LogService) {}

  @Get('pods/:namespace/container/:container/logs')
  getContainerLogs(
    @Param('namespace') namespace: string,
    @Param('container') container: string,
    @Query('tail') tail?: string,
    @Query('since') since?: string,
    @Query('level') level?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (level && !VALID_LEVELS.has(level.toUpperCase())) {
      throw new BadRequestException(`Nivel inválido: ${level}. Válidos: ${[...VALID_LEVELS].join(', ')}`);
    }

    return this.logService.getAggregatedLogs({
      namespace,
      container,
      tail: parsePositiveInt(tail, 'tail', MAX_TAIL),
      since: parsePositiveInt(since, 'since'),
      level,
      search,
      limit: parsePositiveInt(limit, 'limit', MAX_LIMIT),
      offset: parsePositiveInt(offset, 'offset'),
    });
  }

  @Get('pods/:namespace/:pod/logs')
  getLogs(
    @Param('namespace') namespace: string,
    @Param('pod') pod: string,
    @Query('container') container?: string,
    @Query('tail') tail?: string,
    @Query('since') since?: string,
    @Query('level') level?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (level && !VALID_LEVELS.has(level.toUpperCase())) {
      throw new BadRequestException(`Nivel inválido: ${level}. Válidos: ${[...VALID_LEVELS].join(', ')}`);
    }

    return this.logService.getParsedLogs({
      namespace,
      pod,
      container,
      tail: parsePositiveInt(tail, 'tail', MAX_TAIL),
      since: parsePositiveInt(since, 'since'),
      level,
      search,
      limit: parsePositiveInt(limit, 'limit', MAX_LIMIT),
      offset: parsePositiveInt(offset, 'offset'),
    });
  }
}
