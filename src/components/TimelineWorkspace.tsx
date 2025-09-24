import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import TimelineEditor from "../editor/TimelineEditor";
import type { DocumentSnapshot, TextOperation } from "../api/types";
import TimelineSyncController, {
  type InvokeFn,
} from "../sync/TimelineSyncController";

interface TimelineWorkspaceProps {
  invokeApi?: InvokeFn;
  EditorComponent?: typeof TimelineEditor;
}

const defaultInvoke: InvokeFn = (command, args) =>
  tauriInvoke(command, args as Record<string, unknown> | undefined);

export function TimelineWorkspace({
  invokeApi = defaultInvoke,
  EditorComponent,
}: TimelineWorkspaceProps) {
  const controllerRef = useRef<TimelineSyncController | null>(null);
  const [documentContent, setDocumentContent] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const Editor = EditorComponent ?? TimelineEditor;

  const invokeFn = useMemo(() => invokeApi, [invokeApi]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    invokeFn<DocumentSnapshot>("get_document_snapshot")
      .then((snapshot) => {
        if (cancelled) {
          return;
        }

        setDocumentContent(snapshot.content);
        setVersion(snapshot.version);

        controllerRef.current = new TimelineSyncController({
          invoke: invokeFn,
          initialVersion: snapshot.version,
          onConflictResolved: (document, resolvedVersion) => {
            setDocumentContent(document);
            setVersion(resolvedVersion);
            setSyncMessage("Document re-synced after conflict.");
          },
          onEditApplied: (newVersion) => {
            setVersion(newVersion);
            setSyncMessage(null);
          },
        });
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
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
          setError(null);
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
        });
    },
    [],
  );

  if (loading) {
    return (
      <section className="timeline-workspace">
        <p className="status">Loading timeline…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="timeline-workspace" role="alert">
        <p className="status">Error: {error}</p>
      </section>
    );
  }

  return (
    <section className="timeline-workspace">
      <Editor document_content={documentContent} on_change={handleEditorChange} />
      <footer className="workspace-footer">
        <span>Version: {version ?? "unknown"}</span>
        {syncMessage ? <span className="status status--info">{syncMessage}</span> : null}
      </footer>
    </section>
  );
}

export default TimelineWorkspace;
