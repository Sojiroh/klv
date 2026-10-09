import { useState, useEffect } from 'react';
import { apiRequest } from '../lib/api';

interface ApiResult<T> {
  url: string;
  data: T | null;
  error: string | null;
}

export function useApi<T>(url: string | null) {
  const [result, setResult] = useState<ApiResult<T> | null>(null);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();

    apiRequest<T>(url, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ url, data, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setResult({ url, data: null, error: err instanceof Error ? err.message : String(err) });
      });

    return () => controller.abort();
  }, [url]);

  const current = result !== null && result.url === url ? result : null;

  return {
    data: current?.data ?? null,
    loading: url !== null && current === null,
    error: current?.error ?? null,
  };
}
