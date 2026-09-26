"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Developer mode: a per-browser switch that reveals what the studio hides by
 * default - each agent's steps and tool calls, the Demo/Governed choice, and
 * links to the workbench. Remembered in localStorage (a convenience only; it
 * is fine for it to come back off).
 *
 * useSyncExternalStore rather than an effect: the server renders "off", the
 * client reads the real value without a hydration mismatch, and a change in
 * another tab follows along through the storage event.
 */
const KEY = "audience-studio:developer-mode";
const EVENT = "audience-studio:developer-mode-change";
/** Where the switch lives when storage is blocked, so it still works for this page. */
let memory = false;

function read(): boolean {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored === null ? memory : stored === "on";
  } catch {
    return memory;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

export function useDeveloperMode(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => {
    memory = next;
    try {
      window.localStorage.setItem(KEY, next ? "on" : "off");
    } catch {
      // Storage blocked (private window) - the switch just won't persist.
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [on, set];
}
