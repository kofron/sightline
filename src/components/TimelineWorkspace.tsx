import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import TimelineEditor from "../editor/TimelineEditor";
import ChatPane, { type ChatPaneProps } from "./ChatPane";
import type { DocumentSnapshot, TextOperation } from "../api/types";
import TimelineSyncController, {
  type InvokeFn,
} from "../sync/TimelineSyncController";

interface TimelineWorkspaceProps {
  invokeApi?: InvokeFn;
  EditorComponent?: typeof TimelineEditor;
  ChatPaneComponent?: ComponentType<ChatPaneProps>;
}

const defaultInvoke: InvokeFn = (command, args) =>
  tauriInvoke(command, args as Record<string, unknown> | undefined);

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

        controllerRef.current = new TimelineSyncController({
          invoke: invokeFn,
          initialVersion: snapshot.version,
          onConflictResolved: (document, resolvedVersion) => {
            setDocumentContent(document);
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
      controllerRef.current = null;
    };
  }, [invokeFn]);

  const handleEditorChange = useCallback(
    (operations: TextOperation[], nextText: string) => {
      const controller = controllerRef.current;
      if (!controller || operations.length === 0) {
        return;
      }

      setDocumentContent(nextText);
      controller
        .handleEditorChange(operations)
        .then(() => {
          if (!isInitialized) {
            setIsInitialized(true);
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error("failed to apply edit", message);
        });
    },
    [isInitialized],
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
