import { useEffect, useMemo, useRef } from "react";
import type { MutableRefObject } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import LexicalErrorBoundary from "@lexical/react/LexicalErrorBoundary";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalEditor,
} from "lexical";

import type { TextOperation } from "../api/types";

const EDITOR_NAMESPACE = "SightlineTimelineEditor";

export interface TimelineEditorProps {
  document_content: string;
  on_change?: (ops: TextOperation[], nextText: string) => void;
  register_editor?: (editor: LexicalEditor) => void;
}

export function TimelineEditor({
  document_content,
  on_change,
  register_editor,
}: TimelineEditorProps) {
  const initialContentRef = useRef(document_content);
  const externalTextRef = useRef(document_content);

  const initialConfig = useMemo(
    () => ({
      namespace: EDITOR_NAMESPACE,
      nodes: [],
      theme: {},
      onError(error: unknown) {
        throw error;
      },
      editorState() {
        writeDocumentContent(initialContentRef.current);
      },
    }),
    [],
  );

  return (
    <div className="timeline-editor">
      <LexicalComposer initialConfig={initialConfig}>
        <DocumentContentPlugin
          documentContent={document_content}
          externalTextRef={externalTextRef}
        />
        <ChangeListenerPlugin
          externalTextRef={externalTextRef}
          onChange={on_change}
        />
        <EditorReadyPlugin onReady={register_editor} />
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              data-testid="timeline-editor-content"
              className="timeline-editor__content"
              aria-label="Timeline editor"
            />
          }
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
      </LexicalComposer>
    </div>
  );
}

function DocumentContentPlugin({
  documentContent,
  externalTextRef,
}: {
  documentContent: string;
  externalTextRef: MutableRefObject<string>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (externalTextRef.current === documentContent) {
      return;
    }

    editor.update(
      () => {
        writeDocumentContent(documentContent);
      },
      { tag: "remote" },
    );

    externalTextRef.current = documentContent;
  }, [documentContent, editor, externalTextRef]);

  return null;
}

function ChangeListenerPlugin({
  externalTextRef,
  onChange,
}: {
  externalTextRef: MutableRefObject<string>;
  onChange?: (ops: TextOperation[], nextText: string) => void;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, tags }) => {
      const nextText = editorState.read(() => $getRoot().getTextContent());

      if (tags.has("remote")) {
        externalTextRef.current = nextText;
        return;
      }

      const previousText = externalTextRef.current;
      if (nextText === previousText) {
        return;
      }

      const operations = computeOperations(previousText, nextText);
      externalTextRef.current = nextText;

      if (operations.length > 0) {
        onChange?.(operations, nextText);
      }
    });
  }, [editor, externalTextRef, onChange]);

  return null;
}

function EditorReadyPlugin({
  onReady,
}: {
  onReady?: (editor: LexicalEditor) => void;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (onReady) {
      onReady(editor);
    }
  }, [editor, onReady]);

  return null;
}

function computeOperations(previousText: string, nextText: string): TextOperation[] {
  if (previousText === nextText) {
    return [];
  }

  const previousChars = Array.from(previousText);
  const nextChars = Array.from(nextText);

  let prefixLength = 0;
  while (
    prefixLength < previousChars.length &&
    prefixLength < nextChars.length &&
    previousChars[prefixLength] === nextChars[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < previousChars.length - prefixLength &&
    suffixLength < nextChars.length - prefixLength &&
    previousChars[previousChars.length - 1 - suffixLength] ===
      nextChars[nextChars.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const operations: TextOperation[] = [];

  const deleteCount = previousChars.length - prefixLength - suffixLength;
  if (deleteCount > 0) {
    operations.push({
      type: "delete",
      start_position: prefixLength,
      end_position: prefixLength + deleteCount,
    });
  }

  const insertCount = nextChars.length - prefixLength - suffixLength;
  if (insertCount > 0) {
    const insertedText = nextChars
      .slice(prefixLength, prefixLength + insertCount)
      .join("");
    operations.push({
      type: "insert",
      position: prefixLength,
      text: insertedText,
    });
  }

  return operations;
}

function writeDocumentContent(text: string) {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  if (text.length > 0) {
    paragraph.append($createTextNode(text));
  }
  root.append(paragraph);
}

export default TimelineEditor;
