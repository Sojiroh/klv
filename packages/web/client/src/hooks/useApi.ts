import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../lib/api';

interface ApiResult<T> {
  url: string;
  data: T | null;
  error: string | null;
  /** Responses (successful or failed) received for `url` so far. */
  settled: number;
}

export function useApi<T>(url: string | null) {
  const [result, setResult] = useState<ApiResult<T> | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();

    apiRequest<T>(url, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) {
          setResult((prev) => ({ url, data, error: null, settled: (prev?.url === url ? prev.settled : 0) + 1 }));
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // A failed reload keeps the last data of the same URL on screen
        setResult((prev) => ({
          url,
          data: prev?.url === url ? prev.data : null,
          error: err instanceof Error ? err.message : String(err),
          settled: (prev?.url === url ? prev.settled : 0) + 1,
        }));
      });

    return () => controller.abort();
  }, [url, version]);

  // Refetches the same URL; the current data stays until the new response arrives
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  const current = result !== null && result.url === url ? result : null;

  return {
    data: current?.data ?? null,
    loading: url !== null && current === null,
    error: current?.error ?? null,
    /** Changes after every response, including failed ones, even when `data` keeps its reference. */
    settled: current?.settled ?? 0,
    reload,
  };
}
