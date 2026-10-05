import { describe, expect, test } from "bun:test";
import { hashCanonicalPayload } from "../../src/application/wagering/payload-hash";

describe("hashCanonicalPayload", () => {
  test("is independent from object key order", () => {
    expect(hashCanonicalPayload({ b: 2, a: { d: 4, c: 3 } })).toBe(
      hashCanonicalPayload({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  test("changes when a business value changes", () => {
    expect(hashCanonicalPayload({ amount: "10.00" })).not.toBe(
      hashCanonicalPayload({ amount: "10.01" }),
    );
  });
});
