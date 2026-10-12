/**
 * Read, and while `done` rejects the value and the budget allows, wait and read
 * again. Returns the last value read and how many waits it took; the caller
 * decides what a value that never satisfied `done` means.
 */
export async function pollUntil<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  budget: { waits: number; wait: () => Promise<void> },
): Promise<{ value: T; waits: number }> {
  let value = await read();
  let waits = 0;
  while (!done(value) && waits < budget.waits) {
    await budget.wait();
    waits++;
    value = await read();
  }
  return { value, waits };
}
