import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import TimelineEditor from "../editor/TimelineEditor";
import ChatPane, { type ChatPaneProps } from "./ChatPane";
import type { DocumentSnapshot, TextOperation } from "../api/types";
import TimelineSyncController, {
  type InvokeFn,
} from "../sync/TimelineSyncController";
import computeOperations from "../editor/operations";

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

export function TimelineWorkspace({
  invokeApi = defaultInvoke,
  EditorComponent,
  ChatPaneComponent,
}: TimelineWorkspaceProps) {
  const controllerRef = useRef<TimelineSyncController | null>(null);
  const [documentContent, setDocumentContent] = useState("");
  const [isInitialized, setIsInitialized] = useState(false);
  const [isSessionOpen, setIsSessionOpen] = useState(false);
  const [sessionDocument, setSessionDocument] = useState("");
  const [isSessionLoading, setIsSessionLoading] = useState(false);

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

  const openCollaborativeSession = useCallback(() => {
    if (isSessionOpen) {
      return;
    }

    const today = formatDateForApi(new Date());
    setIsSessionOpen(true);
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
  }, [invokeFn, isSessionOpen]);

  const closeCollaborativeSession = useCallback(() => {
    setIsSessionOpen(false);
    setSessionDocument("");
    setIsSessionLoading(false);
  }, []);

  return (
    <section className="timeline-workspace" data-initialized={isInitialized}>
      <div className="timeline-workspace__toolbar">
        {!isSessionOpen && (
          <button
            type="button"
            className="timeline-workspace__reflect"
            onClick={openCollaborativeSession}
            data-testid="reflect-button"
          >
            Reflect
          </button>
        )}
      </div>

      {!isSessionOpen ? (
        <div
          className="timeline-workspace__main"
          data-testid="timeline-main-view"
        >
          <Editor
            document_content={documentContent}
            on_change={handleEditorChange}
          />
        </div>
      ) : (
        <div
          className="collaborative-session"
          data-testid="collaborative-session-view"
          data-loading={isSessionLoading}
        >
          <div className="collaborative-session__toolbar">
            <button
              type="button"
              onClick={closeCollaborativeSession}
              data-testid="close-session-button"
            >
              Close
            </button>
          </div>
          <div className="collaborative-session__panes">
            <div className="collaborative-session__pane collaborative-session__pane--editor">
              <Editor
                document_content={sessionDocument}
                on_change={handleSessionEditorChange}
              />
            </div>
            <div className="collaborative-session__pane collaborative-session__pane--chat">
              <ChatPaneView isDailyLogEmpty={sessionDocument.trim().length === 0} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default TimelineWorkspace;
