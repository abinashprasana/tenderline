import { describe, expect, it } from "vitest";

import { safeNext, tokenExpiry } from "@/auth/session";
import { validatePayload } from "@/screens/approvals/payload";

import { countdown, money, moneyShort, urgency } from "./format";
import { can } from "./permissions";

describe("money", () => {
  it("formats decimal strings without floating point", () => {
    expect(money("1250000.00", "EUR")).toBe("€1,250,000");
    expect(money("12345678901234567890.99", "EUR")).toContain("12,345,678,901,234,567,890");
    expect(money(null, "EUR")).toBe("Not stated");
    expect(moneyShort("450000", "EUR")).toBe("€450K");
  });
});

describe("deadlines", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  it("counts down and grades urgency", () => {
    expect(countdown("2026-11-14T15:30:00Z", now)).toBe("3d 3h");
    expect(countdown("2026-11-11T13:05:00Z", now)).toBe("1h 5m");
    expect(countdown("2026-11-10T00:00:00Z", now)).toBe("Closed");
    expect(urgency("2026-11-12T00:00:00Z", now)).toBe("critical");
    expect(urgency("2026-11-20T00:00:00Z", now)).toBe("soon");
    expect(urgency("2026-12-20T00:00:00Z", now)).toBe("later");
    expect(urgency(null, now)).toBe("none");
  });
});

describe("roles mirror the API", () => {
  it("lets reviewers decide but not write, and only owners administer", () => {
    expect(can("viewer", "decide")).toBe(false);
    expect(can("reviewer", "decide")).toBe(true);
    expect(can("reviewer", "write")).toBe(false);
    expect(can("bid_manager", "write")).toBe(true);
    expect(can("bid_manager", "admin")).toBe(false);
    expect(can("owner", "admin")).toBe(true);
    expect(can(undefined, "read")).toBe(false);
  });
});

describe("payload validation follows the exported JSON schemas", () => {
  it("applies reminder limits", () => {
    expect(validatePayload("add_deadline_reminders", { days_before: [14, 7] })).toEqual({});
    expect(validatePayload("add_deadline_reminders", { days_before: [] }).days_before).toMatch(/at least 1/);
    expect(validatePayload("add_deadline_reminders", { days_before: [91] }).days_before).toMatch(/between 1 and 90/);
    expect(validatePayload("add_deadline_reminders", { days_before: [1, 2, 3, 4, 5, 6, 7] }).days_before).toMatch(/At most 6/);
  });

  it("applies text limits", () => {
    expect(validatePayload("draft_clarification_question", { question: "Too short" }).question).toMatch(/At least 10/);
    expect(validatePayload("mark_no_bid", { reason: "" }).reason).toBe("Required.");
    expect(validatePayload("create_opportunity", {})).toEqual({});
  });
});

describe("session helpers", () => {
  it("only follows same-app paths after sign-in", () => {
    expect(safeNext("/o/1/approvals")).toBe("/o/1/approvals");
    expect(safeNext("//evil.example")).toBe("/app");
    expect(safeNext("https://evil.example")).toBe("/app");
    expect(safeNext(undefined)).toBe("/app");
  });

  it("reads the expiry from a token", () => {
    const payload = btoa(JSON.stringify({ exp: 2_000_000_000 })).replace(/=+$/, "");
    expect(tokenExpiry(`a.${payload}.b`)).toBe(2_000_000_000_000);
    expect(tokenExpiry("garbage")).toBe(0);
  });
});
