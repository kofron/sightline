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
  const [isInitialized, setIsInitialized] = useState(false);

  const Editor = EditorComponent ?? TimelineEditor;

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

  return (
    <section className="timeline-workspace" data-initialized={isInitialized}>
      <Editor document_content={documentContent} on_change={handleEditorChange} />
    </section>
  );
}

export default TimelineWorkspace;
