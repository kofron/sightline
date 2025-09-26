import { describe, expect, it } from "bun:test";

import type { TextNode, LexicalNode } from "lexical";

import {
  buildTagSuggestions,
  extractTagContext,
} from "../src/editor/plugins/TagPlugin";
import type { TagDescriptor } from "../src/lib/tag-store";

type FakeNode = FakeElementNode | FakeTextNode;

class FakeElementNode {
  parent: FakeElementNode | null = null;
  children: FakeNode[] = [];

  constructor(children: FakeNode[] = []) {
    for (const child of children) {
      this.append(child);
    }
  }

  append(child: FakeNode) {
    child.parent = this;
    this.children.push(child);
  }

  getParent(): LexicalNode | null {
    return (this.parent as unknown) as LexicalNode | null;
  }

  getChildren(): LexicalNode[] {
    return (this.children as unknown) as LexicalNode[];
  }

  getTextContent(): string {
    return this.children.map((child) => child.getTextContent()).join("");
  }

  getTextContentSize(): number {
    return this.getTextContent().length;
  }
}

class FakeTextNode {
  parent: FakeElementNode | null = null;

  constructor(private readonly text: string) {}

  getParent(): LexicalNode | null {
    return (this.parent as unknown) as LexicalNode | null;
  }

  getTextContent(): string {
    return this.text;
  }

  getTextContentSize(): number {
    return this.text.length;
  }
}

function buildTagTestTree(parts: string[]): { node: TextNode; text: string } {
  const textNodes = parts.map((part) => new FakeTextNode(part));
  const paragraph = new FakeElementNode();
  for (const node of textNodes) {
    paragraph.append(node);
  }
  const root = new FakeElementNode();
  root.append(paragraph);

  const target = textNodes[textNodes.length - 1];
  return {
    node: (target as unknown) as TextNode,
    text: parts[parts.length - 1] ?? "",
  };
}

function createTagMap(descriptors: TagDescriptor[]): Map<number, TagDescriptor> {
  const map = new Map<number, TagDescriptor>();
  for (const descriptor of descriptors) {
    map.set(descriptor.id, descriptor);
  }
  return map;
}

describe("extractTagContext", () => {
  it("returns null when hashtag is at the start of a line", () => {
    const { node, text } = buildTagTestTree(["#heading"]);
    const result = extractTagContext(node, text, text.length);
    expect(result).toBeNull();
  });

  it("captures query details when the hashtag is mid-line", () => {
    const tag = "#projects:refactr";
    const { node, text } = buildTagTestTree(["Working on ", tag]);
    const result = extractTagContext(node, text, text.length);
    expect(result).toEqual({
      startOffset: 0,
      endOffset: tag.length,
      query: "projects:refactr",
    });
  });

  it("ignores hashtags that follow heading markers", () => {
    const { node, text } = buildTagTestTree(["# ", "#weekly"]);
    const result = extractTagContext(node, text, text.length);
    expect(result).toBeNull();
  });
});

describe("buildTagSuggestions", () => {
  const tagDescriptors: TagDescriptor[] = [
    { id: 1, name: "#projects:refactr", color: "orange" },
    { id: 2, name: "#reflection", color: "purple" },
    { id: 3, name: "#planning", color: "teal" },
  ];

  it("includes both prefix and infix matches while offering creation", () => {
    const suggestions = buildTagSuggestions("ref", createTagMap(tagDescriptors));

    const [createOption, ...matches] = suggestions;
    expect(createOption.isNew).toBe(true);
    expect(createOption.descriptor.name).toBe("#ref");

    const names = matches.map((item) => item.descriptor.name);
    expect(names).toContain("#projects:refactr");
    expect(names).toContain("#reflection");
  });

  it("omits the creation option when an exact match exists", () => {
    const suggestions = buildTagSuggestions(
      "projects:refactr",
      createTagMap(tagDescriptors),
    );

    expect(suggestions.length).toBeGreaterThan(0);
    const createEntry = suggestions.find((item) => item.isNew);
    expect(createEntry).toBeUndefined();
    expect(suggestions[0]?.descriptor.name).toBe("#projects:refactr");
  });

  it("returns an empty array when the query is null", () => {
    const suggestions = buildTagSuggestions(null, createTagMap(tagDescriptors));
    expect(suggestions).toEqual([]);
  });
});
