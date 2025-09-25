import crypto, { createHash } from "node:crypto";
import { createRequire } from "node:module";

const anyCrypto = crypto as typeof crypto & {
  default?: typeof crypto;
  hash?: (
    algorithm: string,
    data: crypto.BinaryLike,
    encoding?: crypto.BinaryToTextEncoding
  ) => string | Buffer;
};

if (typeof anyCrypto.hash !== "function") {
  const polyfill = (
    algorithm: string,
    data: crypto.BinaryLike,
    encoding?: crypto.BinaryToTextEncoding
  ): string | Buffer => {
    const hash = createHash(algorithm).update(data);
    return encoding ? hash.digest(encoding) : hash.digest();
  };

  Object.defineProperty(anyCrypto, "hash", {
    configurable: true,
    writable: true,
    value: polyfill,
  });

  if (anyCrypto.default && typeof anyCrypto.default.hash !== "function") {
    Object.defineProperty(anyCrypto.default, "hash", {
      configurable: true,
      writable: true,
      value: polyfill,
    });
  }

  try {
    const require = createRequire(import.meta.url);
    const cjsCrypto = require("node:crypto") as typeof crypto & {
      hash?: typeof polyfill;
    };

    if (typeof cjsCrypto.hash !== "function") {
      Object.defineProperty(cjsCrypto, "hash", {
        configurable: true,
        writable: true,
        value: polyfill,
      });
    }
  } catch {
    // ignore when CommonJS bridge is unavailable
  }
}

const versions = process.versions as typeof process.versions & {
  bun?: string;
};

if (versions.bun && (!process.version.startsWith("v20") && !process.version.startsWith("v22"))) {
  const bunVersion = versions.bun.split(".").map((segment) => Number.parseInt(segment, 10) || 0);
  const major = bunVersion[0] ?? 0;
  const minor = bunVersion[1] ?? 0;
  const fakeNodeMajor = major >= 1 ? 22 : 20;
  const fakeNodeMinor = major >= 1 ? 12 : 19;
  const fakeNodePatch = minor;
  const fakeVersion = `v${fakeNodeMajor}.${fakeNodeMinor}.${fakeNodePatch}`;

  Object.defineProperty(process, "version", {
    configurable: true,
    get: () => fakeVersion,
  });

  Object.defineProperty(process, "versions", {
    configurable: true,
    value: new Proxy(versions, {
      get(target, prop, receiver) {
        if (prop === "node") {
          return `${fakeNodeMajor}.${fakeNodeMinor}.${fakeNodePatch}`;
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
  });
}
