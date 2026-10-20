// Platform-specific wording for the desktop app's pages. The panic hotkey is
// registered as CommandOrControl+Shift+H, so its label differs per OS, and
// macOS calls the tray the menu bar.

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export const PANIC_KEY = IS_MAC ? "⌘⇧H" : "Ctrl+Shift+H";
export const TRAY_NAME = IS_MAC ? "menu-bar icon" : "tray icon";
