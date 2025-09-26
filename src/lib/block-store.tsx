import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface BlockMetadata {
  index: number;
  startOffset: number;
  endOffset: number;
  tags: number[];
}

interface BlockStoreValue {
  blocks: BlockMetadata[];
  replaceAll(descriptors: BlockMetadata[]): void;
}

const BlockStoreContext = createContext<BlockStoreValue | null>(null);

export function BlockStoreProvider({ children }: { children: ReactNode }) {
  const [blocks, setBlocks] = useState<BlockMetadata[]>([]);

  const replaceAll = useCallback((descriptors: BlockMetadata[]) => {
    setBlocks(() => [...descriptors]);
  }, []);

  const value = useMemo<BlockStoreValue>(
    () => ({ blocks, replaceAll }),
    [blocks, replaceAll],
  );

  return <BlockStoreContext.Provider value={value}>{children}</BlockStoreContext.Provider>;
}

export function useBlockStore(): BlockStoreValue {
  const context = useContext(BlockStoreContext);
  if (!context) {
    throw new Error("useBlockStore must be used within a BlockStoreProvider");
  }
  return context;
}
