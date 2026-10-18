/**
 * Minimal stand-in for the `obsidian` module.
 *
 * Unit tests exercise pure logic and stores, none of which need a real app.
 * This stub exists so importing a module that transitively imports `obsidian`
 * does not fail, and so an accidental UI dependency in a "pure" module shows up
 * as an obvious test failure rather than a confusing resolution error.
 */

export class Notice {
  constructor(
    public readonly message: string,
    public readonly duration?: number,
  ) {}

  hide(): void {}
}

export class Plugin {
  constructor() {
    throw new Error("Plugin is not available in unit tests");
  }
}

export class PluginSettingTab {
  constructor() {
    throw new Error("PluginSettingTab is not available in unit tests");
  }
}

export class ItemView {
  constructor() {
    throw new Error("ItemView is not available in unit tests");
  }
}

export class Setting {
  constructor() {
    throw new Error("Setting is not available in unit tests");
  }
}

/**
 * Extendable so a module defining a Modal subclass can be imported for its pure
 * exports. Constructing one still fails: a test that needs a real dialog is a
 * test that belongs in the smoke run.
 */
export class Modal {
  constructor() {
    throw new Error("Modal is not available in unit tests");
  }
}

export class DropdownComponent {
  constructor() {
    throw new Error("DropdownComponent is not available in unit tests");
  }
}

export function setIcon(): void {}

/** Desktop, as far as the unit tests are concerned; tests probe their own. */
export const Platform = {
  isMobile: false,
  isPhone: false,
  isTablet: false,
  isDesktopApp: true,
};

export class TAbstractFile {
  path = "";
}

/**
 * Constructible, unlike the real one, so a test can hand a fake vault a file. The
 * modules under test only ever read these fields and check `instanceof`.
 */
export class TFile extends TAbstractFile {
  extension = "md";
  basename = "";
  stat = { ctime: 0, mtime: 0, size: 0 };

  constructor(init: Partial<TFile> = {}) {
    super();
    Object.assign(this, init);
  }
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
