import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import TimelineEditor from "../editor/TimelineEditor";
import ChatPane, { type ChatPaneProps } from "./ChatPane";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import type { DocumentSnapshot, TextOperation } from "../api/types";
import TimelineSyncController, {
  type InvokeFn,
} from "../sync/TimelineSyncController";
import computeOperations from "../editor/operations";
import { cn } from "@/lib/utils";

interface TimelineWorkspaceProps {
  invokeApi?: InvokeFn;
  EditorComponent?: typeof TimelineEditor;
  ChatPaneComponent?: ComponentType<ChatPaneProps>;
}

const defaultInvoke: InvokeFn = (command, args) =>
  tauriInvoke(command, args as Record<string, unknown> | undefined);

const EDIT_FLUSH_DELAY_MS = 24;

function formatDateForApi(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateForDisplay(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
  });
}

type ReflectState = 'hidden' | 'ready' | 'active';

export function TimelineWorkspace({
  invokeApi = defaultInvoke,
  EditorComponent,
  ChatPaneComponent,
}: TimelineWorkspaceProps) {
  const controllerRef = useRef<TimelineSyncController | null>(null);
  const [documentContent, setDocumentContent] = useState("");
  const [isInitialized, setIsInitialized] = useState(false);
  const [reflectState, setReflectState] = useState<ReflectState>('hidden');
  const [sessionDocument, setSessionDocument] = useState("");
  const [, setIsSessionLoading] = useState(false);
  const [currentDate, setCurrentDate] = useState<string>(formatDateForDisplay(new Date()));
  const [isAtToday, setIsAtToday] = useState(true);
  const editorRef = useRef<HTMLDivElement>(null!);

  const latestDocumentRef = useRef("");
  const projectedDocumentRef = useRef("");
  const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const Editor = EditorComponent ?? TimelineEditor;
  const ChatPaneView = ChatPaneComponent ?? ChatPane;

  const invokeFn = useMemo(() => invokeApi, [invokeApi]);

  useEffect(() => {
    let cancelled = false;

    invokeFn<DocumentSnapshot>("get_document_snapshot")
      .then((snapshot) => {
        if (cancelled) {
          return;
        }

        setDocumentContent(snapshot.content);
        latestDocumentRef.current = snapshot.content;
        projectedDocumentRef.current = snapshot.content;

        controllerRef.current = new TimelineSyncController({
          invoke: invokeFn,
          initialVersion: snapshot.version,
          onConflictResolved: (document, resolvedVersion) => {
            setDocumentContent(document);
            latestDocumentRef.current = document;
            projectedDocumentRef.current = document;
            if (flushTimeoutRef.current) {
              clearTimeout(flushTimeoutRef.current);
              flushTimeoutRef.current = null;
            }
            console.info("timeline resynced to version", resolvedVersion);
          },
          onEditApplied: (newVersion) => {
            console.debug("edit applied at version", newVersion);
          },
        });
        setIsInitialized(true);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error("failed to load document snapshot", message);
      });

    return () => {
      cancelled = true;
      if (flushTimeoutRef.current) {
        clearTimeout(flushTimeoutRef.current);
        flushTimeoutRef.current = null;
      }
      controllerRef.current = null;
    };
  }, [invokeFn]);

  const flushPendingOperations = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) {
      return;
    }

    const sourceContent = projectedDocumentRef.current;
    const targetContent = latestDocumentRef.current;
    const operations = computeOperations(sourceContent, targetContent);

    if (operations.length === 0) {
      return;
    }

    projectedDocumentRef.current = targetContent;

    controller
      .handleEditorChange(operations)
      .then(() => {
        setIsInitialized(true);
      })
      .catch((err) => {
        projectedDocumentRef.current = sourceContent;
        const message = err instanceof Error ? err.message : String(err);
        console.error("failed to apply edit", message);
      });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimeoutRef.current) {
      clearTimeout(flushTimeoutRef.current);
    }

    flushTimeoutRef.current = setTimeout(() => {
      flushTimeoutRef.current = null;
      flushPendingOperations();
    }, EDIT_FLUSH_DELAY_MS);
  }, [flushPendingOperations]);

  const handleEditorChange = useCallback(
    (_operations: TextOperation[], nextText: string) => {
      if (nextText === latestDocumentRef.current) {
        return;
      }

      setDocumentContent(nextText);
      latestDocumentRef.current = nextText;
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const handleSessionEditorChange = useCallback(
    (_operations: TextOperation[], nextText: string) => {
      setSessionDocument(nextText);
    },
    [],
  );

  const openReflectSession = useCallback(() => {
    if (reflectState !== 'ready') {
      return;
    }

    const today = formatDateForApi(new Date());
    setReflectState('active');
    setIsSessionLoading(true);
    setSessionDocument("");

    invokeFn<string>("get_log_for_date", { date: today })
      .then((content) => {
        setSessionDocument(content);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("failed to load daily log", message);
        setSessionDocument("");
      })
      .finally(() => {
        setIsSessionLoading(false);
      });
  }, [invokeFn, reflectState]);

  const cancelReflectSession = useCallback(() => {
    setReflectState('ready');
    setSessionDocument("");
    setIsSessionLoading(false);
  }, []);

  const completeReflectSession = useCallback(() => {
    setReflectState('ready');
    setSessionDocument("");
    setIsSessionLoading(false);
  }, []);

  const jumpToToday = useCallback(() => {
    // TODO: Scroll to bottom of timeline
    setIsAtToday(true);
    setCurrentDate(formatDateForDisplay(new Date()));
    setReflectState('ready');
  }, []);

  // Check if we're viewing today when content changes
  useEffect(() => {
    // This is a simplified check - in reality you'd parse the document
    // to determine what date range is currently visible
    const today = formatDateForDisplay(new Date());
    setIsAtToday(currentDate === today);
    setReflectState(currentDate === today ? 'ready' : 'hidden');
  }, [currentDate]);

  return (
    <div className={cn(
      "h-screen w-screen bg-background text-foreground flex overflow-hidden",
      "dark" // Force dark mode for now
    )} data-initialized={isInitialized}>
      {/* Left sidebar - Date indicator */}
      <div className="w-20 border-r border-border bg-card flex flex-col">
        <div className="flex-1 flex flex-col justify-end p-4 gap-2">
          <Badge
            variant="secondary"
            className="rotate-90 origin-center whitespace-nowrap text-xs"
          >
            {currentDate}
          </Badge>
        </div>
        <div className="p-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={jumpToToday}
            className="w-full text-xs"
            disabled={isAtToday}
          >
            Today
          </Button>
        </div>
      </div>

      {/* Center editor - 80% width */}
      <div className="flex-1 flex flex-col relative min-h-0">
        <div className="flex-1 relative min-h-0" ref={editorRef}>
          <Editor
            document_content={reflectState === 'active' ? sessionDocument : documentContent}
            on_change={reflectState === 'active' ? handleSessionEditorChange : handleEditorChange}
            scroll_container_ref={editorRef}
            scroll_to_bottom={isInitialized && isAtToday && reflectState !== 'active'}
          />
        </div>

        {/* Reflect button - only shows when at today */}
        {reflectState === 'ready' && (
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-10">
            <Button
              onClick={openReflectSession}
              className="shadow-lg"
              data-testid="reflect-button"
            >
              Reflect
            </Button>
          </div>
        )}

        {/* Active reflect controls */}
        {reflectState === 'active' && (
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-10 flex gap-2">
            <Button
              variant="outline"
              onClick={cancelReflectSession}
              data-testid="cancel-button"
            >
              Cancel
            </Button>
            <Button
              onClick={completeReflectSession}
              data-testid="done-button"
            >
              Done
            </Button>
          </div>
        )}
      </div>

      {/* Right chat panel - slides in */}
      <div className={cn(
        "w-80 border-l border-border bg-card transition-transform duration-300 ease-in-out flex flex-col absolute top-0 right-0 h-full z-20",
        reflectState === 'active' ? "translate-x-0" : "translate-x-full"
      )}>
        <div className="p-4 border-b border-border">
          <h2 className="font-semibold text-lg">Daily Reflection</h2>
        </div>
        <div className="flex-1 overflow-hidden">
          {reflectState === 'active' && (
            <ChatPaneView
              isDailyLogEmpty={sessionDocument.trim().length === 0}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default TimelineWorkspace;
