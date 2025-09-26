import { DecoratorNode, type EditorConfig, type LexicalNode, type NodeKey } from "lexical";
import { useMemo } from "react";
import { useTagStore } from "@/lib/tag-store";

export interface TagNodePayload {
  id: number | null;
  name: string;
  color?: string;
  key?: NodeKey;
}

export class TagNode extends DecoratorNode<JSX.Element> {
  __id: number | null;
  __name: string;
  __color: string | null;

  static getType(): string {
    return "tag";
  }

  static clone(node: TagNode): TagNode {
    return new TagNode({
      id: node.__id,
      name: node.__name,
      color: node.__color ?? undefined,
      key: node.__key,
    });
  }

  constructor({ id, name, color, key }: TagNodePayload) {
    super(key);
    this.__id = id ?? null;
    this.__name = name;
    this.__color = color ?? null;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.className = config.theme.tag ?? "";
    return span;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): JSX.Element {
    return <TagChip name={this.__name} id={this.__id} color={this.__color} />;
  }

  exportJSON(): Record<string, unknown> {
    return {
      type: "tag",
      version: 1,
      id: this.__id,
      name: this.__name,
      color: this.__color,
    };
  }

  getTextContent(): string {
    return this.__name;
  }

  getTagId(): number | null {
    return this.__id;
  }

  getTagName(): string {
    return this.__name;
  }

  getTagColor(): string | null {
    return this.__color;
  }

  setTag(id: number, name: string, color?: string): void {
    const writable = this.getWritable();
    writable.__id = id;
    writable.__name = name;
    writable.__color = color ?? null;
  }
}

export function $createTagNode(payload: TagNodePayload): TagNode {
  return new TagNode(payload);
}

export function $isTagNode(node: LexicalNode | null | undefined): node is TagNode {
  return node instanceof TagNode;
}

function TagChip({
  id,
  name,
  color,
}: {
  id: number | null;
  name: string;
  color: string | null;
}) {
  const { tags } = useTagStore();
  const resolved = useMemo(() => {
    if (id !== null) {
      const descriptor = tags.get(id);
      if (descriptor) {
        return descriptor;
      }
    }
    const lower = name.toLowerCase();
    for (const descriptor of tags.values()) {
      if (descriptor.name.toLowerCase() === lower) {
        return descriptor;
      }
    }
    return null;
  }, [id, name, tags]);

  const backgroundColor = resolved?.color ?? color ?? "var(--tag-default-bg, rgba(148, 163, 184, 0.28))";
  const textColor = "var(--tag-default-fg, #0f172a)";

  return (
    <span
      className="tag-chip"
      style={{
        backgroundColor,
        color: textColor,
      }}
      data-tag-name={name}
    >
      {name}
    </span>
  );
}
