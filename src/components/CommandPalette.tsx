import { Command } from "cmdk";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";

export interface CommandPaletteProps {
  onReflect: () => void;
  onToday: () => void;
  onFocusDate?: (isoDate: string) => void;
}

interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  perform: () => void;
}

const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }

  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function normalizeDateInput(input: string): string | null {
  const trimmed = input.trim();
  if (DATE_REGEX.test(trimmed)) {
    const [, yearPart, monthPart, dayPart] = DATE_REGEX.exec(trimmed) ?? [];
    const year = Number.parseInt(yearPart, 10);
    const month = Number.parseInt(monthPart, 10);
    const day = Number.parseInt(dayPart, 10);
    return isValidDateParts(year, month, day) ? trimmed : null;
  }

  const numeric = trimmed.replace(/[^0-9]/g, "");
  if (numeric.length === 8) {
    const year = Number.parseInt(numeric.slice(0, 4), 10);
    const month = Number.parseInt(numeric.slice(4, 6), 10);
    const day = Number.parseInt(numeric.slice(6, 8), 10);
    if (isValidDateParts(year, month, day)) {
      const formattedMonth = String(month).padStart(2, "0");
      const formattedDay = String(day).padStart(2, "0");
      return `${String(year).padStart(4, "0")}-${formattedMonth}-${formattedDay}`;
    }
  }

  return null;
}

export default function CommandPalette({ onReflect, onToday, onFocusDate }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const metaPressed = isMac ? event.metaKey : event.ctrlKey;
      if (metaPressed && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, []);

  const actions = useMemo<PaletteAction[]>(() => {
    const base: PaletteAction[] = [
      {
        id: "reflect",
        label: "Reflect",
        hint: "Start daily reflection",
        perform: () => {
          onReflect();
          setOpen(false);
        },
      },
      {
        id: "today",
        label: "Jump to Today",
        hint: "Scroll to current day",
        perform: () => {
          onToday();
          setOpen(false);
        },
      },
    ];

    if (onFocusDate) {
      base.push({
        id: "focus-date",
        label: "Focus Date…",
        hint: "View timeline for YYYY-MM-DD",
        perform: () => {
          const normalized = normalizeDateInput(query);
          if (normalized) {
            onFocusDate(normalized);
            setOpen(false);
          }
        },
      });
    }

    return base;
  }, [onReflect, onToday, onFocusDate, query]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
    }
  }, []);

  const isFocusEnabled = Boolean(onFocusDate);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={handleOpenChange}
      label="Command Palette"
      aria-describedby="command-palette-description"
      aria-labelledby="command-palette-title"
    >
      {open ? (
        <Fragment>
          <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity" aria-hidden />
          <div className="fixed inset-0 z-50 flex justify-center pt-24">
            <Command
              className={cn(
                "linear-command w-full max-w-2xl overflow-hidden rounded-2xl border border-white/10",
                "bg-[linear-gradient(136.61deg,#27282b_13.72%,#2d2e31_74.3%)] text-slate-100 shadow-[0px_20px_60px_rgba(0,0,0,0.35)]",
              )}
            >
              <h2 id="command-palette-title" className="sr-only">
                Command Palette
              </h2>
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                <Badge
                  variant="secondary"
                  className="bg-white/10 text-xs font-semibold uppercase tracking-wide text-white"
                >
                  Sightline Commands
                </Badge>
                <div className="flex items-center gap-2 text-[11px] text-slate-300">
                  <kbd className="rounded bg-white/10 px-2 py-1">⌘</kbd>
                  <kbd className="rounded bg-white/10 px-2 py-1">K</kbd>
                </div>
              </div>
              <div className="px-4 pb-2 pt-3">
                <Input
                  autoFocus
                  placeholder="Search commands or type a date..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-12 border-none bg-transparent text-base text-white focus-visible:ring-0 placeholder:text-slate-400"
                />
              </div>
              <span id="command-palette-description" className="sr-only">
                Sightline command palette actions
              </span>
              <Command.List className="max-h-72 overflow-y-auto pb-3">
                <Command.Empty className="px-4 py-6 text-sm text-slate-400">
                  No commands found.
                </Command.Empty>
                <Command.Group
                  heading="Actions"
                  className="space-y-1 px-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400"
                >
                  {actions.map((action) => {
                    const showGoButton = action.id === "focus-date" && isFocusEnabled;
                    const isDisabled = showGoButton && !normalizeDateInput(query);
                    return (
                      <Command.Item
                        key={action.id}
                        value={`${action.label} ${action.hint ?? ""}`.trim()}
                        onSelect={() => {
                          if (isDisabled) {
                            return;
                          }
                          action.perform();
                        }}
                        className={cn(
                          "group flex items-center gap-3 rounded-lg px-3 py-3 text-sm text-slate-200 transition",
                          "data-[selected=true]:bg-white/10 data-[selected=true]:text-white",
                          "data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-40",
                        )}
                        data-disabled={isDisabled}
                      >
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-medium tracking-wide text-white">
                            {action.label}
                          </span>
                          {action.hint ? (
                            <span className="truncate text-[11px] text-slate-400">
                              {action.hint}
                            </span>
                          ) : null}
                        </div>
                        {showGoButton ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="ml-3 border-white/20 bg-white/10 text-xs text-white hover:bg-white/20"
                            disabled={isDisabled}
                            onClick={(event) => {
                              event.preventDefault();
                              const normalized = normalizeDateInput(query);
                              if (normalized) {
                                onFocusDate?.(normalized);
                                setOpen(false);
                              }
                            }}
                          >
                            Go
                          </Button>
                        ) : null}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              </Command.List>
            </Command>
          </div>
        </Fragment>
      ) : null}
    </Command.Dialog>
  );
}

export { normalizeDateInput };
