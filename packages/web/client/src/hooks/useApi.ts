import { useState, useEffect } from 'react';
import { isTauri, invokeApi } from '../lib/tauri';

export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!url) return;
    setLoading(true);
    setError(null);

    if (isTauri()) {
      invokeApi<T>(url)
        .then(setData)
        .catch((err: any) => setError(err.message ?? String(err)))
        .finally(() => setLoading(false));
    } else {
      fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(setData)
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }
  }, [url]);

  return { data, loading, error, refetch: () => setData(null) };
}
