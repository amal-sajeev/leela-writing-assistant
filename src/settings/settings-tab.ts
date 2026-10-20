import { Notice, PluginSettingTab, requireApiVersion, Setting, type App } from "obsidian";

import { DEFAULT_MODELS, PROVIDER_DISPLAY_NAMES } from "../constants";
import type LyraPlugin from "../main";
import { describeProviderError, toProviderError } from "../providers/provider-errors";
import { PROVIDER_IDS, type ProviderId } from "../types";
import { debounce, type Debounced } from "../utils/debounce";
import {
  DEFAULT_ESSAY_FOCUS,
  DEFAULT_FICTION_FOCUS,
  SETTING_LIMITS,
  type LyraSettings,
} from "./settings";

/** How long a text field waits after the last keystroke before it saves. */
const TYPING_SAVE_DELAY_MS = 500;

/**
 * One short page: who answers, when she reads, how she reads, how she shows up.
 */
export class LyraSettingTab extends PluginSettingTab {
  private readonly typing = new Map<string, Debounced<[(draft: LyraSettings) => void]>>();

  constructor(
    app: App,
    private readonly plugin: LyraPlugin,
  ) {
    super(app, plugin);
  }

  private get settings(): LyraSettings {
    return this.plugin.prefs;
  }

  /** Saves a text field once the author stops typing in it. */
  private saveWhenTypingPauses(field: string, mutate: (draft: LyraSettings) => void): void {
    let pending = this.typing.get(field);
    if (pending === undefined) {
      pending = debounce((latest: (draft: LyraSettings) => void) => {
        void this.plugin.updateSettings(latest);
      }, TYPING_SAVE_DELAY_MS);
      this.typing.set(field, pending);
    }
    pending.call(mutate);
  }

  private saveTypedNow(): void {
    for (const pending of this.typing.values()) pending.flush();
  }

  override hide(): void {
    this.saveTypedNow();
    super.hide();
  }

  override display(): void {
    this.saveTypedNow();

    const { containerEl } = this;
    const scrollTop = containerEl.scrollTop;
    containerEl.empty();

    this.renderProvider();
    this.renderReading();
    this.renderNovels();
    this.renderWindow();

    containerEl.scrollTop = scrollTop;
  }

  private renderProvider(): void {
    const { containerEl } = this;
    const provider = this.settings.provider;

    new Setting(containerEl).setName("Who answers").setHeading();

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("The passage you ask about, and the text around it, is sent to this service.")
      .addDropdown((dropdown) => {
        for (const id of PROVIDER_IDS) dropdown.addOption(id, PROVIDER_DISPLAY_NAMES[id]);
        dropdown.setValue(provider).onChange((value) => {
          void this.plugin
            .updateSettings((draft) => {
              draft.provider = value as ProviderId;
            })
            .then(() => this.display());
        });
      });

    new Setting(containerEl)
      .setName(`${PROVIDER_DISPLAY_NAMES[provider]} API key`)
      .setDesc(
        requireApiVersion("1.11.4")
          ? "Kept in Obsidian's secret storage, not in the plugin's own data file."
          : "Kept in this vault's plugin data. Obsidian 1.11.4 or later would keep it in secret storage instead.",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text
          .setPlaceholder("Paste your API key")
          .setValue(this.settings.providers[provider].apiKey)
          .onChange((value) => {
            this.saveWhenTypingPauses(`apiKey:${provider}`, (draft) => {
              draft.providers[provider].apiKey = value.trim();
            });
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Any model name the provider accepts.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_MODELS[provider])
          .setValue(this.settings.providers[provider].model)
          .onChange((value) => {
            this.saveWhenTypingPauses(`model:${provider}`, (draft) => {
              draft.providers[provider].model = value.trim();
            });
          }),
      )
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true).setButtonText("Testing…");
          this.saveTypedNow();
          try {
            await this.plugin.providers.require(provider).validateConfiguration();
            new Notice(`${PROVIDER_DISPLAY_NAMES[provider]} is reachable and the model works.`);
          } catch (error) {
            new Notice(describeProviderError(toProviderError(error), provider), 8000);
          } finally {
            button.setDisabled(false).setButtonText("Test");
          }
        }),
      );
  }

  private renderReading(): void {
    const { containerEl } = this;
    const name = this.settings.companion.name;

    new Setting(containerEl).setName("How she reads").setHeading();

    new Setting(containerEl)
      .setName("What you are writing")
      .setDesc(
        "Fiction: she reads for character, dialogue, pacing, point of view and feeling, and asks rather than corrects where a choice may be deliberate. Essay: she reads for clarity, reasoning and evidence.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("fiction", "Fiction")
          .addOption("essay", "Essays, articles and notes")
          .setValue(this.settings.persona.mode)
          .onChange((value) => {
            void this.plugin
              .updateSettings((draft) => {
                draft.persona.mode = value === "essay" ? "essay" : "fiction";
              })
              .then(() => this.display());
          }),
      );

    new Setting(containerEl)
      .setName("How she puts it")
      .setDesc("Her manner only. What she notices, and what she lets pass, stay the same.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("gentle", "Gentle")
          .addOption("balanced", "Balanced")
          .addOption("direct", "Direct")
          .setValue(this.settings.persona.tone)
          .onChange((value) => {
            void this.plugin.updateSettings((draft) => {
              draft.persona.tone = value === "gentle" || value === "direct" ? value : "balanced";
            });
          }),
      );

    new Setting(containerEl)
      .setName("Talk in character")
      .setDesc(
        `On, ${name} talks to you the way she would across a table: informal, dry, unimpressed, a little teasing. Off, she is plain and neutral. Either way she finds the same things.`,
      )
      .addToggle((toggle) =>
        toggle.setValue(this.settings.persona.inCharacter).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.persona.inCharacter = value;
          });
        }),
      );

    new Setting(containerEl)
      .setName("Read along as I write")
      .setDesc(
        `On, ${name} reads each passage after you pause on it. Off, nothing is sent until you select text and ask.`,
      )
      .addToggle((toggle) =>
        toggle.setValue(this.settings.liveReview.enabled).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.liveReview.enabled = value;
          });
        }),
      );

    new Setting(containerEl)
      .setName("Manual review depth")
      .setDesc("Quick is one pass. Standard adds a focused pass for longer selections. Exhaustive checks overlapping sections for structure, continuity, clarity, and prose.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("quick", "Quick read")
          .addOption("standard", "Editorial review")
          .addOption("exhaustive", "Exhaustive review")
          .setValue(this.settings.manualReview.depth)
          .onChange((value) => {
            void this.plugin.updateSettings((draft) => {
              draft.manualReview.depth = value === "exhaustive" || value === "standard" ? value : "quick";
            });
          }),
      );

    new Setting(containerEl)
      .setName("Unlimited findings in manual reviews")
      .setDesc("No findings-count cap. Reviews still have request, context, and time limits. Live review stays at one finding per pause.")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.manualReview.unlimitedFindings).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.manualReview.unlimitedFindings = value;
          });
        }),
      );

    new Setting(containerEl)
      .setName("Manual finding limit")
      .setDesc("Used when unlimited findings are off.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 20, 1)
          .setValue(this.settings.manualReview.maximumFindings)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.plugin.updateSettings((draft) => {
              draft.manualReview.maximumFindings = Math.round(value);
            });
          }),
      );

    new Setting(containerEl)
      .setName("Fact-check claims during manual reviews")
      .setDesc("For essay reviews, flags internal contradictions and claims that need sources. Lyra does not fetch the web or call a claim false from memory.")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.manualReview.factCheck).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.manualReview.factCheck = value;
          });
        }),
      );

    new Setting(containerEl)
      .setName("Pause before she reads")
      .setDesc("Seconds without typing before a changed passage is read.")
      .addSlider((slider) =>
        slider
          .setLimits(SETTING_LIMITS.debounceMs.min / 1000, SETTING_LIMITS.debounceMs.max / 1000, 0.5)
          .setValue(this.settings.liveReview.debounceMs / 1000)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.plugin.updateSettings((draft) => {
              draft.liveReview.debounceMs = Math.round(value * 1000);
            });
          }),
      );

    new Setting(containerEl)
      .setName("How much she lets pass")
      .setDesc("Left, she speaks only about serious problems. Right, she mentions small ones too.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setValue(this.settings.persona.pickiness)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.plugin.updateSettings((draft) => {
              draft.persona.pickiness = value;
            });
          }),
      );

    new Setting(containerEl)
      .setName("Say when something works")
      .setDesc("At most one compliment per reading, and only with a reason.")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.persona.praise).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.persona.praise = value;
          });
        }),
      );

    const ignored = this.settings.ignoredCategories;
    if (ignored.length > 0) {
      const row = new Setting(containerEl)
        .setName("What she no longer mentions")
        .setDesc("Press one to let her raise it again.");

      for (const category of ignored) {
        row.addButton((button) =>
          button
            .setButtonText(`${category} ×`)
            .setTooltip(`Let her mention ${category} again`)
            .onClick(() => {
              void this.plugin
                .updateSettings((draft) => {
                  draft.ignoredCategories = draft.ignoredCategories.filter((entry) => entry !== category);
                })
                .then(() => this.display());
            }),
        );
      }
    }

    new Setting(containerEl)
      .setName("What she looks for")
      .setDesc("In your own words. Leave empty to go back to the default.")
      .addTextArea((area) => {
        area.inputEl.rows = 5;
        area.inputEl.addClass("lyra-settings__focus");
        area
          .setPlaceholder(
            this.settings.persona.mode === "fiction" ? DEFAULT_FICTION_FOCUS : DEFAULT_ESSAY_FOCUS,
          )
          .setValue(this.settings.persona.focus)
          .onChange((value) => {
            this.saveWhenTypingPauses("focus", (draft) => {
              draft.persona.focus = value;
            });
          });
      });
  }

  private renderNovels(): void {
    const { containerEl } = this;
    const name = this.settings.companion.name;

    new Setting(containerEl).setName("Novels").setHeading();

    new Setting(containerEl)
      .setName("Keep notes on the story")
      .setDesc(
        `A folder with a story brief in it is a novel, and the notes directly in it are its chapters. On, ${name} reads a chapter a few minutes after you stop changing it and keeps notes on characters, places, the timeline and open threads in a “Lyra notes” folder there. Each changed chapter is sent to your provider, without asking each time. She never reads more than three chapters unasked.`,
      )
      .addToggle((toggle) =>
        toggle.setValue(this.settings.story.keepNotes).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.story.keepNotes = value;
          });
        }),
      );

    new Setting(containerEl)
      .setName("Remember chats between sessions")
      .setDesc("Off, saved chats and saved memory stop being sent. New messages and memory edits stay in memory until Obsidian closes; saved files remain until you clear them in the chat.")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.story.rememberConversations).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.story.rememberConversations = value;
          });
        }),
      );
  }

  private renderWindow(): void {
    const { containerEl } = this;

    new Setting(containerEl).setName("Her window").setHeading();

    new Setting(containerEl)
      .setName("Where she stands")
      .setDesc(
        "Over the right sidebar keeps her off the page you are writing on. While that sidebar is closed she stands in the editor's corner instead.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("sidebar", "Over the right sidebar")
          .addOption("editor", "In the editor's corner")
          .setValue(this.settings.companion.place)
          .onChange((value) => {
            void this.plugin.updateSettings((draft) => {
              draft.companion.place = value === "editor" ? "editor" : "sidebar";
            });
          }),
      );

    new Setting(containerEl).setName("Her name").addText((text) =>
      text
        .setPlaceholder("Lyra")
        .setValue(this.settings.companion.name)
        .onChange((value) => {
          this.saveWhenTypingPauses("name", (draft) => {
            draft.companion.name = value;
          });
        }),
    );

    new Setting(containerEl)
      .setName("Speak up on her own")
      .setDesc(
        "On, her message box opens when she has something, once you have stopped typing. Off, she only shows a count and waits for a click.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.settings.companion.speakUp).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.companion.speakUp = value;
          });
        }),
      );

    new Setting(containerEl)
      .setName("Seconds a line stays up")
      .setDesc("After this the message box folds away again. Hovering keeps it open.")
      .addSlider((slider) =>
        slider
          .setLimits(SETTING_LIMITS.lingerSeconds.min, SETTING_LIMITS.lingerSeconds.max, 1)
          .setValue(this.settings.companion.lingerSeconds)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.plugin.updateSettings((draft) => {
              draft.companion.lingerSeconds = value;
            });
          }),
      );

    new Setting(containerEl)
      .setName("Old television")
      .setDesc(
        "Scanlines and a little picture noise over her scene, and a burst of static when it changes, like turning the dial. Both are stilled if your system asks for reduced motion.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.settings.companion.crt).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.companion.crt = value;
          });
        }),
      );

    new Setting(containerEl)
      .setName("Window size")
      .setDesc(
        this.settings.companion.width === null
          ? "Fitted to where she stands. Drag the top-left corner of her window to resize it."
          : `Set by dragging to ${this.settings.companion.width} pixels wide when she is speaking.`,
      )
      .addButton((button) =>
        button
          .setButtonText("Reset")
          .setDisabled(this.settings.companion.width === null)
          .onClick(() => {
            void this.plugin
              .updateSettings((draft) => {
                draft.companion.width = null;
              })
              .then(() => this.display());
          }),
      );

    new Setting(containerEl)
      .setName("Underline what she commented on")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.underline).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.underline = value;
          });
        }),
      );
  }
}
