import { Modal, type App } from "obsidian";

/**
 * Exactly what last left the machine, for the author to read.
 *
 * She says she only sees the passage and what is around it. This is how that can
 * be checked: the text shown here is the text that was sent, not a description
 * of it.
 */

export interface SentRecord {
  /** What it was sent for, in a few words. */
  purpose: string;
  provider: string;
  model: string;
  at: number;
  systemPrompt: string;
  userPrompt: string;
}

export function showSent(app: App, record: SentRecord): void {
  new SentModal(app, record).open();
}

class SentModal extends Modal {
  constructor(
    app: App,
    private readonly record: SentRecord,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, record } = this;
    contentEl.empty();
    contentEl.addClass("lyra-sent");

    contentEl.createEl("h3", { text: "What was last sent" });
    contentEl.createDiv({
      cls: "lyra-sent__meta",
      text: `${record.purpose}. Sent to ${record.provider} (${record.model}) at ${new Date(record.at).toLocaleTimeString()}. ${(
        record.systemPrompt.length + record.userPrompt.length
      ).toLocaleString()} characters in all.`,
    });

    contentEl.createEl("h4", { text: "Your writing and notes" });
    contentEl.createEl("pre", { cls: "lyra-sent__text", text: record.userPrompt });

    contentEl.createEl("h4", { text: "Her instructions" });
    contentEl.createEl("pre", { cls: "lyra-sent__text", text: record.systemPrompt });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
