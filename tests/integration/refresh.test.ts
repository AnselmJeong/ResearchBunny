import { test } from "bun:test";
import assert from "node:assert/strict";
import { refreshQueue } from "../../src/shared/refresh-queue";

test("progress bursts keep one snapshot in flight and read the final saved result", async () => {
  let calls = 0, inFlight = 0, maximum = 0, status = "running";
  const seen: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const queue = refreshQueue(async () => {
    calls++;
    maximum = Math.max(maximum, ++inFlight);
    const saved = status;
    if (calls === 1) await blocked;
    seen.push(saved);
    inFlight--;
  }, error => { throw error; }, 1);
  try {
    queue.request();
    for (let i = 0; i < 100 && !calls; i++) await Bun.sleep(1);
    assert.equal(calls, 1);
    for (let i = 0; i < 111; i++) queue.request();
    status = "completed";
    queue.request();
    release();
    for (let i = 0; i < 100 && seen.length < 2; i++) await Bun.sleep(1);
    assert.equal(maximum, 1);
    assert.equal(calls, 2);
    assert.deepEqual(seen, ["running", "completed"]);
  } finally { release(); queue.dispose(); }
});

test("a polling refresh recovers after a failed read and disposal ignores late errors", async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const queue = refreshQueue(async () => { if (++calls === 1) throw new Error("lost RPC reply"); }, error => errors.push(error), 1);
  queue.request();
  for (let i = 0; i < 100 && !errors.length; i++) await Bun.sleep(1);
  assert.equal(errors.length, 1);
  queue.request();
  for (let i = 0; i < 100 && calls < 2; i++) await Bun.sleep(1);
  assert.equal(calls, 2);
  queue.dispose();
  queue.request();
  await Bun.sleep(5);
  assert.equal(calls, 2);
});
