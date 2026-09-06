// Keep one running task and only the newest pending request for this owner.
export function createLatestTask<T>(run: (value: T) => Promise<void>) {
  let pending: { value: T } | null = null;
  let flight: Promise<void> | null = null;
  return {
    request(value: T): Promise<void> {
      pending = { value };
      if (!flight) {
        flight = (async () => {
          while (pending) {
            const next = pending;
            pending = null;
            await run(next.value);
          }
        })().finally(() => { flight = null; });
      }
      return flight;
    },
    cancelPending() { pending = null; },
  };
}
