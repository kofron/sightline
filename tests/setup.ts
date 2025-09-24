import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});

const { window } = dom;

globalThis.window = window as unknown as typeof globalThis.window;
globalThis.document = window.document;
globalThis.navigator = window.navigator;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.DOMRect = window.DOMRect;
await import("mutationobserver-shim");
globalThis.MutationObserver = window.MutationObserver;
