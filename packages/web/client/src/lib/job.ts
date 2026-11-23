/** Resumable computation: yields at safe points so a driver can hand the main thread back between slices. */
export type Job<T> = Generator<void, T, undefined>;

/** Items processed between two yield points (power of two: the check is a mask). */
export const JOB_CHUNK = 512;

/** Runs a job to completion without yielding to the event loop. */
export function drain<T>(job: Job<T>): T {
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}
