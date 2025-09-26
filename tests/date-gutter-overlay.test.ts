import { describe, expect, it } from "bun:test";

import { computeMarkers, formatShortDate } from "../src/components/DateGutterOverlay";

describe("DateGutterOverlay helpers", () => {
  it("formats ISO dates as M/D/YY", () => {
    expect(formatShortDate("2024-01-05")).toBe("1/5/24");
    expect(formatShortDate("2025-12-31")).toBe("12/31/25");
  });

  it("returns raw string when parsing fails", () => {
    expect(formatShortDate("not-a-date")).toBe("not-a-date");
  });

  it("computes markers on date transitions", () => {
    const blocks = [
      { index: 0, startOffset: 0, endOffset: 5, date: "2024-01-01", tags: [] },
      { index: 1, startOffset: 5, endOffset: 10, date: "2024-01-01", tags: [] },
      { index: 2, startOffset: 10, endOffset: 15, date: "2024-01-02", tags: [] },
    ];

    const markers = computeMarkers(blocks);
    expect(markers).toEqual([
      { id: "0:2024-01-01", date: "2024-01-01", startOffset: 0 },
      { id: "2:2024-01-02", date: "2024-01-02", startOffset: 10 },
    ]);
  });
});
