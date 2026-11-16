import { describe, expect, it } from "vitest";

import { findTasks, GUIDANCE, sectionFor } from "./guidance";

describe("guide sections", () => {
  it("follows the route, including Today with or without a trailing slash", () => {
    expect(sectionFor("/o/abc")).toBe("today");
    expect(sectionFor("/o/abc/")).toBe("today");
    expect(sectionFor("/o/abc/approvals")).toBe("approvals");
    expect(sectionFor("/o/abc/opportunities")).toBe("opportunities");
    expect(sectionFor("/o/abc/opportunities/xyz")).toBe("opportunity");
    expect(sectionFor("/o/abc/ingestion")).toBe("ingestion");
    expect(sectionFor("/welcome")).toBe("welcome");
    expect(sectionFor("/o/abc/unknown")).toBe("today");
  });

  it("offers at most three next steps per screen", () => {
    for (const entry of Object.values(GUIDANCE)) expect(entry.links.length).toBeLessThanOrEqual(3);
  });
});

describe("tips and the task finder", () => {
  it("gives every screen one to three tips", () => {
    for (const entry of Object.values(GUIDANCE)) {
      expect(entry.tips.length).toBeGreaterThanOrEqual(1);
      expect(entry.tips.length).toBeLessThanOrEqual(3);
    }
  });

  it("finds tasks by their words, best match first, and needs every word", () => {
    expect(findTasks("")).toEqual([]);
    expect(findTasks("reminder")[0]?.label).toBe("Add a reminder to a tender");
    expect(findTasks("calendar")[0]?.to).toBe("/o/$orgId/deadlines");
    expect(findTasks("invite")[0]?.label).toBe("Invite a teammate");
    expect(findTasks("dark mode")[0]?.to).toBe("/o/$orgId/settings");
    expect(findTasks("watchlist").every((t) => /watchlist/i.test(`${t.label} ${t.words}`))).toBe(true);
    expect(findTasks("xyzzy")).toEqual([]);
    expect(findTasks("a", 3)).toHaveLength(3);
  });
});
