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
import {
  TagStoreProvider,
  useTagStore,
  type TagDescriptor,
} from "@/lib/tag-store";
import {
  BlockStoreProvider,
  useBlockStore,
  type BlockMetadata,
} from "@/lib/block-store";
import TagPlugin from "../editor/plugins/TagPlugin";

interface TimelineWorkspaceProps {
  invokeApi?: InvokeFn;
  EditorComponent?: typeof TimelineEditor;
  ChatPaneComponent?: ComponentType<ChatPaneProps>;
}

interface BackendBlockMetadata {
    index: number;
    start_offset: number;
    end_offset: number;
    tags?: number[];
}

function mapBackendBlock(descriptor: BackendBlockMetadata): BlockMetadata {
  return {
    index: descriptor.index,
    startOffset: descriptor.start_offset,
    endOffset: descriptor.end_offset,
    tags: descriptor.tags ?? [],
  };
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
  return (
    <TagStoreProvider>
      <BlockStoreProvider>
        <TimelineWorkspaceInner
          invokeApi={invokeApi}
          EditorComponent={EditorComponent}
          ChatPaneComponent={ChatPaneComponent}
        />
      </BlockStoreProvider>
    </TagStoreProvider>
  );
}

function TimelineWorkspaceInner({
  invokeApi = defaultInvoke,
  EditorComponent,
  ChatPaneComponent,
}: TimelineWorkspaceProps) {
  const controllerRef = useRef<TimelineSyncController | null>(null);
  const [documentContent, setDocumentContent] = useState("");
  const [isInitialized, setIsInitialized] = useState(false);
  const [reflectState, setReflectState] = useState<ReflectState>('hidden');
  const [isSessionLoading, setIsSessionLoading] = useState(false);
  const [isDailyLogEmpty, setIsDailyLogEmpty] = useState(true);
  const [currentDate, setCurrentDate] = useState<string>(formatDateForDisplay(new Date()));
  const [isAtToday, setIsAtToday] = useState(true);
  const editorRef = useRef<HTMLDivElement>(null!);

  const latestDocumentRef = useRef("");
  const projectedDocumentRef = useRef("");
  const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const Editor = EditorComponent ?? TimelineEditor;
  const ChatPaneView = ChatPaneComponent ?? ChatPane;

  const invokeFn = useMemo(() => invokeApi, [invokeApi]);
  const { replaceAll: replaceAllTags } = useTagStore();
  const { replaceAll: replaceAllBlocks } = useBlockStore();

  const refreshBlocks = useCallback(() => {
    invokeFn<BackendBlockMetadata[]>("list_blocks")
      .then((metadata) => {
        replaceAllBlocks(metadata.map(mapBackendBlock));
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("failed to list blocks", message);
      });
  }, [invokeFn, replaceAllBlocks]);

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
        refreshBlocks();
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

  useEffect(() => {
    let cancelled = false;

    invokeFn<TagDescriptor[]>("list_tags")
      .then((descriptors) => {
        if (!cancelled) {
          replaceAllTags(descriptors);
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("failed to list tags", message);
      });

    return () => {
      cancelled = true;
      // TODO: When the backend can stream block/tag diffs, replace this
      // eager fetch with an incremental patch to keep contexts aligned
      // without redundant full-state requests.
    };
  }, [invokeFn, replaceAllTags]);

  useEffect(() => {
    refreshBlocks();
    // TODO: Swap this eager fetch with diff-based updates once the backend
    // can emit block change deltas (bounded context alignment).
  }, [refreshBlocks]);

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
        refreshBlocks();
      })
      .catch((err) => {
        projectedDocumentRef.current = sourceContent;
        const message = err instanceof Error ? err.message : String(err);
        console.error("failed to apply edit", message);
      });
  }, [refreshBlocks]);

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

  const openReflectSession = useCallback(() => {
    if (reflectState !== 'ready') {
      return;
    }

    const today = formatDateForApi(new Date());
    setReflectState('active');
    setIsSessionLoading(true);
    setIsDailyLogEmpty(true);

    invokeFn<string>("get_log_for_date", { date: today })
      .then((content) => {
        setIsDailyLogEmpty(content.trim().length === 0);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("failed to load daily log", message);
        setIsDailyLogEmpty(true);
      })
      .finally(() => {
        setIsSessionLoading(false);
      });
  }, [invokeFn, reflectState]);

  const cancelReflectSession = useCallback(() => {
    setReflectState('ready');
    setIsSessionLoading(false);
  }, []);

  const completeReflectSession = useCallback(() => {
    setReflectState('ready');
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
    <div
      className={cn(
      "h-screen w-screen bg-background text-foreground flex overflow-hidden",
      "dark" // Force dark mode for now
    )}
      data-initialized={isInitialized}
      data-testid="timeline-main-view"
    >
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
      <div className="flex-1 flex flex-col relative min-h-0" ref={editorRef}>
        <Editor
          document_content={documentContent}
          on_change={handleEditorChange}
          scroll_container_ref={editorRef}
          scroll_to_bottom={isInitialized && isAtToday}
          plugins={
            <TagPlugin invokeApi={invokeFn} refreshBlocks={refreshBlocks} />
          }
        />

        {/* Reflect button - bottom right when ready */}
        {reflectState === 'ready' && (
          <div className="absolute bottom-6 right-6 z-50 pointer-events-auto">
            <Button
              onClick={openReflectSession}
              className="shadow-lg"
              data-testid="reflect-button"
              type="button"
            >
              Reflect
            </Button>
          </div>
        )}

        {reflectState === 'active' && (
          <ReflectOverlay
            onCancel={cancelReflectSession}
            onComplete={completeReflectSession}
            isLoading={isSessionLoading}
            ChatPaneComponent={ChatPaneView}
            isDailyLogEmpty={isDailyLogEmpty}
          />
        )}
      </div>
    </div>
  );
}

interface ReflectOverlayProps {
  onCancel: () => void;
  onComplete: () => void;
  isLoading: boolean;
  ChatPaneComponent: ComponentType<ChatPaneProps>;
  isDailyLogEmpty: boolean;
}

function ReflectOverlay({
  onCancel,
  onComplete,
  isLoading,
  ChatPaneComponent,
  isDailyLogEmpty,
}: ReflectOverlayProps) {
  return (
    <div
      className="fixed bottom-20 right-6 z-40 w-[min(28rem,calc(100vw-3rem))] max-h-[85vh]"
      data-testid="collaborative-session-view"
    >
      <div className="rounded-xl border border-border bg-card shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="font-semibold text-lg">Daily Reflection</h2>
          <Button variant="ghost" size="sm" onClick={onCancel} data-testid="close-session-button">
            Close
          </Button>
        </div>
        <div className="flex-1 overflow-hidden">
          {isLoading ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              Loading daily log…
            </div>
          ) : (
            <ChatPaneComponent isDailyLogEmpty={isDailyLogEmpty} />
          )}
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <Button variant="outline" onClick={onCancel} data-testid="cancel-button">
            Cancel
          </Button>
          <Button onClick={onComplete} data-testid="done-button">
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

export default TimelineWorkspace;
