import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface TagDescriptor {
  id: number;
  name: string;
  color: string;
}

interface TagStoreValue {
  tags: Map<number, TagDescriptor>;
  replaceAll(descriptors: TagDescriptor[]): void;
  upsert(descriptors: TagDescriptor[]): void;
}

const TagStoreContext = createContext<TagStoreValue | null>(null);

export function TagStoreProvider({ children }: { children: ReactNode }) {
  const [tags, setTags] = useState<Map<number, TagDescriptor>>(new Map());

  const replaceAll = useCallback((descriptors: TagDescriptor[]) => {
    setTags(() => {
      const next = new Map<number, TagDescriptor>();
      for (const descriptor of descriptors) {
        next.set(descriptor.id, descriptor);
      }
      return next;
    });
  }, []);

  const upsert = useCallback((descriptors: TagDescriptor[]) => {
    if (descriptors.length === 0) {
      return;
    }

    setTags((previous) => {
      const next = new Map(previous);
      for (const descriptor of descriptors) {
        next.set(descriptor.id, descriptor);
      }
      return next;
    });
  }, []);

  const value = useMemo<TagStoreValue>(
    () => ({ tags, replaceAll, upsert }),
    [tags, replaceAll, upsert],
  );

  return <TagStoreContext.Provider value={value}>{children}</TagStoreContext.Provider>;
}

export function useTagStore(): TagStoreValue {
  const context = useContext(TagStoreContext);
  if (!context) {
    throw new Error("useTagStore must be used within a TagStoreProvider");
  }
  return context;
}
