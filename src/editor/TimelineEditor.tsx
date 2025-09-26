import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { MutableRefObject } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import LexicalErrorBoundary from "@lexical/react/LexicalErrorBoundary";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListItemNode, ListNode } from "@lexical/list";
import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import {
  TRANSFORMERS,
  $convertFromMarkdownString,
  $convertToMarkdownString,
  type ElementTransformer,
} from "@lexical/markdown";
import { $createParagraphNode, $getRoot, type LexicalEditor } from "lexical";

import type { TextOperation } from "../api/types";
import computeOperations from "./operations";
import { TagNode, $isTagNode } from "./nodes/TagNode";

const EDITOR_NAMESPACE = "SightlineTimelineEditor";
const DEBOUNCELESS_PLACEHOLDER = null;
const TAG_MARKDOWN_TRANSFORMER: ElementTransformer = {
  dependencies: [TagNode],
  export: (node) => {
    if ($isTagNode(node)) {
      return node.getTextContent();
    }
    return null;
  },
  regExp: /^$/,
  replace: () => {
    // Import side intentionally left empty. Tag nodes are created explicitly
    // during tagging flows; legacy markdown remains plain text.
  },
  type: "element",
};

const MARKDOWN_TRANSFORMERS = [...TRANSFORMERS, TAG_MARKDOWN_TRANSFORMER];

export interface TimelineEditorProps {
  document_content: string;
  on_change?: (ops: TextOperation[], nextText: string) => void;
  register_editor?: (editor: LexicalEditor) => void;
  scroll_container_ref?: React.RefObject<HTMLDivElement>;
  scroll_to_bottom?: boolean;
  plugins?: ReactNode;
}

export function TimelineEditor({
  document_content,
  on_change,
  register_editor,
  scroll_container_ref,
  scroll_to_bottom,
  plugins,
}: TimelineEditorProps) {
  const initialContentRef = useRef(document_content);
  const externalTextRef = useRef(document_content);
  // Scroll to bottom when requested
  useEffect(() => {
    if (scroll_to_bottom && scroll_container_ref?.current) {
      setTimeout(() => {
        const container = scroll_container_ref.current;
        if (container) {
          const contentEditable = container.querySelector('.timeline-editor__content');
          if (contentEditable) {
            contentEditable.scrollTo({
              top: contentEditable.scrollHeight,
              behavior: 'smooth'
            });
          }
        }
      }, 200);
    }
  }, [scroll_to_bottom, scroll_container_ref]);

  const initialConfig = useMemo(
    () => ({
      namespace: EDITOR_NAMESPACE,
      theme: {},
      nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode, TagNode],
      onError(error: unknown) {
        throw error;
      },
      editorState() {
        setEditorMarkdown(initialContentRef.current);
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
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              data-testid="timeline-editor-content"
              className="timeline-editor__content"
              aria-label="Timeline editor"
            />
          }
          placeholder={DEBOUNCELESS_PLACEHOLDER}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ListPlugin />
        <MarkdownShortcutPlugin transformers={MARKDOWN_TRANSFORMERS} />
        {plugins}
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
        setEditorMarkdown(documentContent);
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
      const nextMarkdown = editorState.read(() => {
        const markdown = $convertToMarkdownString(MARKDOWN_TRANSFORMERS, undefined, true);
        return normalizeMarkdown(markdown);
      });

      if (tags.has("remote")) {
        externalTextRef.current = nextMarkdown;
        return;
      }

      const previousText = externalTextRef.current;
      if (nextMarkdown === previousText) {
        return;
      }

      const operations = computeOperations(previousText, nextMarkdown);
      externalTextRef.current = nextMarkdown;

      if (operations.length > 0) {
        onChange?.(operations, nextMarkdown);
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

function setEditorMarkdown(markdown: string) {
  const normalized = normalizeMarkdown(markdown);
  const root = $getRoot();
  root.clear();
  $convertFromMarkdownString(normalized, MARKDOWN_TRANSFORMERS, undefined, true);

  if (root.getFirstChild() === null) {
    root.append($createParagraphNode());
  }
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n');
}

export default TimelineEditor;
