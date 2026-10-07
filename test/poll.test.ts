import { describe, it, expect } from "vitest";
import { pollUntil } from "../src/poll.js";

describe("pollUntil", () => {
  it("returns the first value without waiting when it's already done", async () => {
    let waited = 0;
    const got = await pollUntil(() => 7, (v) => v === 7, { waits: 3, wait: async () => void waited++ });
    expect(got).toEqual({ value: 7, waits: 0 });
    expect(waited).toBe(0);
  });

  it("waits and re-reads until done", async () => {
    let n = 0;
    const got = await pollUntil(async () => n, (v) => v >= 2, { waits: 5, wait: async () => void n++ });
    expect(got).toEqual({ value: 2, waits: 2 });
  });

  it("stops at the budget and hands back the last value", async () => {
    let n = 0;
    const got = await pollUntil(() => n, () => false, { waits: 3, wait: async () => void n++ });
    expect(got).toEqual({ value: 3, waits: 3 });
  });
});
