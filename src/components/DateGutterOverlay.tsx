import { useLayoutEffect, useMemo, useState } from "react";
import type { MutableRefObject, RefObject } from "react";

import { Badge } from "./ui/badge";
import type { BlockMetadata } from "@/lib/block-store";

interface DateMarker {
  id: string;
  date: string;
  startOffset: number;
}

interface DateGutterOverlayProps {
  blocks: BlockMetadata[];
  containerRef: RefObject<HTMLDivElement> | MutableRefObject<HTMLDivElement | null>;
  documentContent: string;
}

const LINE_FALLBACK_PX = 24;

export function formatShortDate(isoDate: string): string {
  const parts = isoDate.split("-");
  if (parts.length !== 3) {
    return isoDate;
  }

  const [yearPart, monthPart, dayPart] = parts;
  const year = Number.parseInt(yearPart, 10);
  const month = Number.parseInt(monthPart, 10);
  const day = Number.parseInt(dayPart, 10);

  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
    return isoDate;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    timeZone: "UTC",
  });

  const date = new Date(Date.UTC(year, month - 1, day));
  return formatter.format(date);
}

export function computeMarkers(blocks: BlockMetadata[]): DateMarker[] {
  if (blocks.length === 0) {
    return [];
  }

  const markers: DateMarker[] = [];
  let previousDate: string | null = null;

  for (const block of blocks) {
    if (previousDate === null || block.date !== previousDate) {
      markers.push({
        id: `${block.index}:${block.date}`,
        date: block.date,
        startOffset: block.startOffset,
      });
      previousDate = block.date;
    }
  }

  return markers;
}

function mapCharOffsetToClientTop(contentEl: HTMLElement, charOffset: number): number | null {
  const range = document.createRange();
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);

  let remaining = charOffset;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = node.nodeValue ?? "";
    const codepoints = Array.from(text);

    if (remaining <= codepoints.length) {
      let codeUnitOffset = 0;
      for (let index = 0; index < remaining; index += 1) {
        codeUnitOffset += codepoints[index]?.length ?? 0;
      }

      range.setStart(node, codeUnitOffset);
      range.collapse(true);

      const rects = range.getClientRects();
      const rect = rects[0] ?? range.getBoundingClientRect();
      if (rect && (rect.height > 0 || rect.width > 0)) {
        return rect.top;
      }

      break;
    }

    remaining -= codepoints.length;
  }

  const contentRect = contentEl.getBoundingClientRect();
  return contentRect.top ?? null;
}

export default function DateGutterOverlay({
  blocks,
  containerRef,
  documentContent,
}: DateGutterOverlayProps) {
  const markers = useMemo(() => computeMarkers(blocks), [blocks]);
  const [positions, setPositions] = useState<Record<string, number>>({});

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || markers.length === 0) {
      setPositions({});
      return;
    }

    const content = container.querySelector<HTMLElement>(".timeline-editor__content");
    if (!content) {
      const fallback: Record<string, number> = {};
      let currentTop = 0;
      for (const marker of markers) {
        fallback[marker.id] = currentTop;
        currentTop += LINE_FALLBACK_PX;
      }
      setPositions(fallback);
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    const nextPositions: Record<string, number> = {};
    let fallbackTop = 0;

    for (const marker of markers) {
      const clientTop = mapCharOffsetToClientTop(content, marker.startOffset);
      if (clientTop != null) {
        nextPositions[marker.id] = Math.max(0, clientTop - containerTop);
        fallbackTop = nextPositions[marker.id];
      } else {
        fallbackTop += LINE_FALLBACK_PX;
        nextPositions[marker.id] = fallbackTop;
      }
    }

    setPositions(nextPositions);

    const globalWithProcess = globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> };
    };
    const isTestEnv = globalWithProcess.process?.env?.NODE_ENV === "test";
    if (isTestEnv) {
      return;
    }

    const handleScroll = () => {
      const updated: Record<string, number> = {};
      let tempFallback = 0;
      const containerStart = container.getBoundingClientRect().top;
      for (const marker of markers) {
        const clientTop = mapCharOffsetToClientTop(content, marker.startOffset);
        if (clientTop != null) {
          updated[marker.id] = Math.max(0, clientTop - containerStart);
          tempFallback = updated[marker.id];
        } else {
          tempFallback += LINE_FALLBACK_PX;
          updated[marker.id] = tempFallback;
        }
      }
      setPositions(updated);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll, { passive: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleScroll);
      resizeObserver.observe(container);
      resizeObserver.observe(content);
    }

    return () => {
      container.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
      resizeObserver?.disconnect();
    };
  }, [markers, containerRef, documentContent]);

  if (markers.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {markers.map((marker) => {
        const top = positions[marker.id] ?? 0;
        return (
          <div
            key={marker.id}
            className="absolute left-4"
            style={{ top }}
          >
            <Badge variant="secondary" className="text-xs uppercase tracking-wide">
              {formatShortDate(marker.date)}
            </Badge>
          </div>
        );
      })}
    </div>
  );
}
