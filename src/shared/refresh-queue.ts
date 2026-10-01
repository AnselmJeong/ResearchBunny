// Progress bursts must not launch overlapping reads or discard the final update.
export function refreshQueue(read: () => Promise<void>, onError: (error: unknown) => void, delay = 250) {
  let disposed = false, running = false, dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = async () => {
    timer = undefined;
    if (disposed || running || !dirty) return;
    dirty = false;
    running = true;
    try { await read(); } catch (error) { if (!disposed) onError(error); }
    finally {
      running = false;
      if (dirty && !disposed) timer = setTimeout(() => void drain(), delay);
    }
  };
  return {
    request() {
      if (disposed) return;
      dirty = true;
      if (!running && !timer) timer = setTimeout(() => void drain(), delay);
    },
    dispose() { disposed = true; clearTimeout(timer); },
  };
}
