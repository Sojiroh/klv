import type { QueryableLog } from '@klv/query';
import { columnLabel, columnValue, type ColumnId } from './columns';
import { exportSave, isTauri } from './tauri';

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** RFC 4180 CSV (CRLF line endings, header row). The `time` column is ISO-8601. */
export function logsToCsv(logs: QueryableLog[], columns: ColumnId[]): string {
  const lines: string[] = new Array(logs.length + 1);
  lines[0] = columns.map((id) => csvField(columnLabel(id))).join(',');
  for (let i = 0; i < logs.length; i++) {
    lines[i + 1] = columns.map((id) => csvField(columnValue(logs[i], id))).join(',');
  }
  return lines.join('\r\n');
}

export function logsToJson(logs: QueryableLog[]): string {
  return JSON.stringify(logs, null, 2);
}

/**
 * Saves a text file. Web: browser download (resolves to `defaultName`). Desktop: native save dialog,
 * resolves to the saved path, or null when the user cancels.
 */
export async function saveFile(defaultName: string, contents: string, mime: string): Promise<string | null> {
  if (isTauri()) return exportSave(defaultName, contents);

  const url = URL.createObjectURL(new Blob([contents], { type: `${mime};charset=utf-8` }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = defaultName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return defaultName;
}
