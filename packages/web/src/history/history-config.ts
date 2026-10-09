import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { assertK8sName } from '@klv/core';
import type { CollectorTarget, HistoryConfig, RetentionSettings } from './history.types';
import { isRecord } from './type-guards';

const MAX_TARGETS = 50;
const MAX_SELECTOR_LENGTH = 1024;
const MAX_AGE_DAYS = { min: 1, max: 365 };
const MAX_SIZE_MB = { min: 64, max: 102_400 };
const TARGET_ID = /^[A-Za-z0-9_-]{1,64}$/;

function optionalString(target: string, field: string, value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${target}: ${field} debe ser un string`);
  return value;
}

function validateRetention(value: unknown): RetentionSettings {
  if (!isRecord(value)) throw new BadRequestException('retention debe ser un objeto');
  const { maxAgeDays, maxSizeMb } = value;
  if (!Number.isInteger(maxAgeDays) || (maxAgeDays as number) < MAX_AGE_DAYS.min || (maxAgeDays as number) > MAX_AGE_DAYS.max) {
    throw new BadRequestException(`retention.maxAgeDays debe ser un entero entre ${MAX_AGE_DAYS.min} y ${MAX_AGE_DAYS.max}`);
  }
  if (!Number.isInteger(maxSizeMb) || (maxSizeMb as number) < MAX_SIZE_MB.min || (maxSizeMb as number) > MAX_SIZE_MB.max) {
    throw new BadRequestException(`retention.maxSizeMb debe ser un entero entre ${MAX_SIZE_MB.min} y ${MAX_SIZE_MB.max}`);
  }
  return { maxAgeDays: maxAgeDays as number, maxSizeMb: maxSizeMb as number };
}

// Valida el cuerpo de PUT /api/history/config y asigna id a los targets nuevos
export function normalizeConfig(body: unknown, knownContexts: string[]): HistoryConfig {
  if (!isRecord(body)) throw new BadRequestException('El cuerpo debe ser un objeto JSON');
  if (!Array.isArray(body.targets) || body.targets.length > MAX_TARGETS) {
    throw new BadRequestException(`targets debe ser un arreglo de hasta ${MAX_TARGETS} elementos`);
  }

  const ids = new Set<string>();
  const targets = body.targets.map((raw: unknown, index): CollectorTarget => {
    const label = `targets[${index}]`;
    if (!isRecord(raw)) throw new BadRequestException(`${label} debe ser un objeto`);

    let id: string;
    if (raw.id == null) {
      id = randomUUID();
    } else if (typeof raw.id === 'string' && TARGET_ID.test(raw.id)) {
      id = raw.id;
    } else {
      throw new BadRequestException(`${label}: id inválido`);
    }
    if (ids.has(id)) throw new BadRequestException(`${label}: id duplicado "${id}"`);
    ids.add(id);

    if (typeof raw.context !== 'string' || raw.context === '') {
      throw new BadRequestException(`${label}: context debe ser un string no vacío`);
    }
    if (!knownContexts.includes(raw.context)) {
      throw new BadRequestException(`${label}: el contexto "${raw.context}" no existe en el kubeconfig`);
    }
    if (typeof raw.namespace !== 'string') throw new BadRequestException(`${label}: namespace debe ser un string`);
    assertK8sName('namespace', raw.namespace);
    if (typeof raw.enabled !== 'boolean') throw new BadRequestException(`${label}: enabled debe ser un booleano`);

    const container = optionalString(label, 'container', raw.container);
    if (container !== undefined) assertK8sName('container', container);
    const labelSelector = optionalString(label, 'labelSelector', raw.labelSelector);
    if (labelSelector !== undefined && labelSelector.length > MAX_SELECTOR_LENGTH) {
      throw new BadRequestException(`${label}: labelSelector no puede superar ${MAX_SELECTOR_LENGTH} caracteres`);
    }

    return {
      id,
      context: raw.context,
      namespace: raw.namespace,
      ...(container !== undefined && { container }),
      ...(labelSelector !== undefined && { labelSelector }),
      enabled: raw.enabled,
    };
  });

  return { targets, retention: validateRetention(body.retention) };
}
