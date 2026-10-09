import { useCallback, useEffect, useState } from 'react';
import { apiRequest, errorMessage } from '../lib/api';
import type { HistoryStatus } from '../types';

const POLL_INTERVAL_MS = 5000;

/** Polls `/api/history/status` every 5 s while the document is visible. */
export function useHistoryStatus() {
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await apiRequest<HistoryStatus>('/api/history/status'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh]);

  return { status, error, refresh };
}
