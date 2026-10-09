import { Controller, Get, Param, Query, BadRequestException } from '@nestjs/common';
import { parseLevel, type LogLevel } from '@klv/core';
import { LogService } from './log.service';

const MAX_TAIL = 10000;
const MAX_LIMIT = 10000;

function parseUint(value: unknown, name: string, { min = 0, max }: { min?: number; max?: number } = {}) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BadRequestException(`${name} debe ser un número entero no negativo`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new BadRequestException(`${name} es demasiado grande`);
  }
  if (n < min) {
    throw new BadRequestException(`${name} debe ser un número entero mayor o igual a ${min}`);
  }
  return max != null ? Math.min(n, max) : n;
}

function parseMinLevel(value: unknown): LogLevel | undefined {
  if (value === undefined) return undefined;
  const level = typeof value === 'string' ? parseLevel(value) : 'UNKNOWN';
  if (level === 'UNKNOWN') {
    throw new BadRequestException(
      `Nivel inválido: ${String(value)}. Válidos: TRACE, DEBUG, INFO, WARN, ERROR, FATAL`,
    );
  }
  return level;
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
    return this.logService.getAggregatedLogs({
      namespace,
      container,
      tail: parseUint(tail, 'tail', { max: MAX_TAIL }),
      since: parseUint(since, 'since', { min: 1 }),
      level: parseMinLevel(level),
      search,
      limit: parseUint(limit, 'limit', { max: MAX_LIMIT }),
      offset: parseUint(offset, 'offset'),
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
    return this.logService.getParsedLogs({
      namespace,
      pod,
      container,
      tail: parseUint(tail, 'tail', { max: MAX_TAIL }),
      since: parseUint(since, 'since', { min: 1 }),
      level: parseMinLevel(level),
      search,
      limit: parseUint(limit, 'limit', { max: MAX_LIMIT }),
      offset: parseUint(offset, 'offset'),
    });
  }
}
