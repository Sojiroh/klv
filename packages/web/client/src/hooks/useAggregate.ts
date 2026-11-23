import { useEffect, useMemo, useRef, useState } from 'react';
import { drain, type Job } from '../lib/job';

/** Inputs up to this size are aggregated during render: cheap enough not to be worth a delay. */
const SYNC_LIMIT = 5000;
/** Longest stretch of work before the main thread is handed back (a frame is ~16 ms). */
const SLICE_MS = 8;
/** Rest between two aggregations, in multiples of what the last one cost: the duty cycle stays ~1/(1+factor). */
const REST_FACTOR = 8;
const MIN_REST_MS = 250;
const MAX_REST_MS = 8000;

interface Latest<I, T> {
  job: (input: I) => Job<T>;
  input: I;
  /** Bumped on every change of `job` or `input`; lets the runner tell what it already aggregated without holding old inputs. */
  version: number;
}

/**
 * Aggregates `input` with `job` without ever monopolising the main thread.
 *
 * Small inputs are aggregated synchronously. Large ones run in slices of at most `SLICE_MS`, one aggregation at
 * a time, always over the newest input, and rest in between for a time proportional to what the last one cost:
 * a 500k-line live buffer is re-aggregated every few seconds instead of on every flush, while a few thousand
 * lines stay instant. Until the first slow aggregation finishes (and while `enabled` is false) `fallback` is returned.
 * `job` must be referentially stable (module-level or `useCallback`): a new one restarts the aggregation.
 */
export function useAggregate<I extends { length: number }, T>(
  input: I,
  job: (input: I) => Job<T>,
  fallback: T,
  enabled = true,
): T {
  const small = input.length <= SYNC_LIMIT;
  const sync = useMemo(() => (enabled && small ? drain(job(input)) : null), [enabled, small, job, input]);

  const [computed, setComputed] = useState<{ value: T } | null>(null);
  const latest = useRef<Latest<I, T>>({ job, input, version: 0 });
  const wake = useRef<(() => void) | null>(null);

  useEffect(() => {
    latest.current = { job, input, version: latest.current.version + 1 };
    wake.current?.();
  }, [job, input]);

  const slow = enabled && !small;
  useEffect(() => {
    if (!slow) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let doneVersion = -1;
    let restUntil = 0;

    // Starts an aggregation of the newest input once the rest is over, unless that input was already aggregated.
    const schedule = () => {
      if (running || timer !== undefined || latest.current.version === doneVersion) return;
      timer = setTimeout(run, Math.max(0, restUntil - performance.now()));
    };

    const run = () => {
      timer = undefined;
      const { job: nextJob, input: nextInput, version } = latest.current;
      const task = nextJob(nextInput);
      let spent = 0;
      running = true;

      const slice = () => {
        timer = undefined;
        const start = performance.now();
        for (;;) {
          const step = task.next();
          if (step.done) {
            spent += performance.now() - start;
            running = false;
            doneVersion = version;
            restUntil = performance.now() + Math.min(MAX_REST_MS, Math.max(MIN_REST_MS, spent * REST_FACTOR));
            setComputed({ value: step.value });
            schedule();
            return;
          }
          if (performance.now() - start >= SLICE_MS) break;
        }
        spent += performance.now() - start;
        timer = setTimeout(slice, 0);
      };
      slice();
    };

    wake.current = schedule;
    schedule();
    return () => {
      wake.current = null;
      clearTimeout(timer);
    };
  }, [slow]);

  if (!enabled) return fallback;
  if (small) return sync as T;
  return computed === null ? fallback : computed.value;
}
