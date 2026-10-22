/**
 * Obsidian exposes `window` in the app, and plugin code uses it for timers and
 * crypto so it keeps working in popout windows. Unit tests run in Node, where
 * there is no `window`, so the same global is provided here for every test file.
 */
(globalThis as { window?: unknown }).window = globalThis;
