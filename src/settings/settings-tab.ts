import { PluginSettingTab, requireApiVersion, Setting, type App, type SettingDefinitionItem } from "obsidian";

import { DEFAULT_MODELS, PROVIDER_DISPLAY_NAMES } from "../constants";
import type LyraPlugin from "../main";
import { describeProviderError, toProviderError } from "../providers/provider-errors";
import { PROVIDER_IDS, type ProviderId } from "../types";
import { debounce, type Debounced } from "../utils/debounce";
import {
  DEFAULT_ESSAY_FOCUS,
  DEFAULT_FICTION_FOCUS,
  MAX_FALLBACK_KEYS,
  MAX_FALLBACK_MODELS,
  SETTING_LIMITS,
  type LyraSettings,
} from "./settings";

/** How long a text field waits after the last keystroke before it saves. */
const TYPING_SAVE_DELAY_MS = 500;

/** Writes one optional slot without leaving holes in the array. */
function withSlot(values: readonly string[], index: number, value: string): string[] {
  const next = [...values];
  while (next.length <= index) next.push("");
  next[index] = value;
  return next;
}

/**
 * One short page: provider, reviews, story memory, and window behavior.
 */
export class LyraSettingTab extends PluginSettingTab {
  private readonly typing = new Map<string, Debounced<[(draft: LyraSettings) => void]>>();
  private fallbackOptionsOpen = false;

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

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Lyra settings",
        render: (setting) => {
          this.saveTypedNow();
          setting.settingEl.addClass("lyra-settings-definition");
          setting.controlEl.addClass("lyra-settings-definition__control");
          const root = setting.controlEl.createDiv({ cls: "lyra-settings-content" });
          this.renderAll(root);
          return () => this.saveTypedNow();
        },
      },
    ];
  }

  override display(): void {
    this.saveTypedNow();
    this.renderAll(this.containerEl);
  }

  private renderAll(containerEl: HTMLElement): void {
    const scrollTop = containerEl.scrollTop;
    containerEl.empty();
    this.renderProvider(containerEl);
    this.renderReviews(containerEl);
    this.renderStoryAndMemory(containerEl);
    this.renderWindow(containerEl);
    containerEl.scrollTop = scrollTop;
  }

  private refreshSettings(): void {
    if (requireApiVersion("1.13.0")) this.update();
    else this.renderAll(this.containerEl);
  }

  private renderProvider(containerEl: HTMLElement): void {
    const provider = this.settings.provider;

    new Setting(containerEl).setName("Provider and model").setHeading();

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
            .then(() => this.refreshSettings());
        });
      });

    new Setting(containerEl)
      .setName(`${PROVIDER_DISPLAY_NAMES[provider]} API key`)
      .setDesc(
        requireApiVersion("1.11.4")
          ? "Saved in Obsidian's secret storage."
          : "Saved with this vault's plugin settings. Obsidian 1.11.4 or later stores it separately.",
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
      .setDesc("Model ID accepted by this provider.")
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
          testStatus.hidden = false;
          testStatus.classList.remove("is-error");
          testStatus.setText("Testing connection and model…");
          this.saveTypedNow();
          try {
            await this.plugin.providers.require(provider).validateConfiguration();
            testStatus.setText(`${PROVIDER_DISPLAY_NAMES[provider]} is reachable and the configured model works.`);
          } catch (error) {
            testStatus.classList.add("is-error");
            testStatus.setText(describeProviderError(toProviderError(error), provider));
          } finally {
            button.setDisabled(false).setButtonText("Test");
          }
        }),
      );

    const testStatus = containerEl.createDiv({
      cls: "lyra-settings__provider-status",
      attr: { role: "status", "aria-live": "polite", hidden: "true" },
    });

    const fallbacks = containerEl.createEl("details", { cls: "lyra-settings-fallbacks" });
    fallbacks.open = this.fallbackOptionsOpen;
    const summary = fallbacks.createEl("summary");
    summary.createSpan({ text: "Fallback options" });
    const summaryCounts = summary.createSpan({ cls: "lyra-settings-fallbacks__summary" });
    const providerSettings = this.settings.providers[provider];
    const fallbackKeyValues = Array.from(
      { length: MAX_FALLBACK_KEYS },
      (_, index) => providerSettings.fallbackKeys[index] ?? "",
    );
    const fallbackModelValues = Array.from(
      { length: MAX_FALLBACK_MODELS },
      (_, index) => providerSettings.fallbackModels[index] ?? "",
    );
    const updateSummaryCounts = (): void => {
      const keyCount = fallbackKeyValues.filter((value) => value.trim().length > 0).length;
      const modelCount = fallbackModelValues.filter((value) => value.trim().length > 0).length;
      const keys = keyCount === 0 ? "no extra keys" : `${keyCount} extra key${keyCount === 1 ? "" : "s"}`;
      const models = modelCount === 0 ? "no fallback models" : `${modelCount} fallback model${modelCount === 1 ? "" : "s"}`;
      summaryCounts.setText(` · ${keys} · ${models}`);
    };
    updateSummaryCounts();
    fallbacks.addEventListener("toggle", () => {
      this.fallbackOptionsOpen = fallbacks.open;
    });
    fallbacks.createDiv({
      cls: "setting-item-description lyra-settings-fallbacks__description",
      text: "Extra keys are tried after the main key is rejected or rate-limited. Extra models are tried when the main model is unavailable.",
    });

    for (let index = 0; index < MAX_FALLBACK_KEYS; index += 1) {
      new Setting(fallbacks)
        .setName(`Fallback API key ${index + 1}`)
        .setDesc(
          index === 0
            ? "Tried in order when the main key is rate-limited or rejected."
            : "Optional.",
        )
        .addText((text) => {
          text.inputEl.type = "password";
          text.inputEl.autocomplete = "off";
          text
            .setPlaceholder("Paste another API key")
            .setValue(fallbackKeyValues[index] ?? "")
            .onChange((value) => {
              fallbackKeyValues[index] = value.trim();
              updateSummaryCounts();
              this.saveWhenTypingPauses(`fallbackKey:${provider}:${index}`, (draft) => {
                draft.providers[provider].fallbackKeys = withSlot(
                  draft.providers[provider].fallbackKeys,
                  index,
                  value.trim(),
                );
              });
            });
        });
    }

    for (let index = 0; index < MAX_FALLBACK_MODELS; index += 1) {
      new Setting(fallbacks)
        .setName(`Fallback model ${index + 1}`)
        .setDesc(
          index === 0
            ? "Optional. Tried when the main model is unavailable or rate-limited."
            : "Optional.",
        )
        .addText((text) =>
          text
            .setPlaceholder("Optional")
            .setValue(fallbackModelValues[index] ?? "")
            .onChange((value) => {
              fallbackModelValues[index] = value.trim();
              updateSummaryCounts();
              this.saveWhenTypingPauses(`fallbackModel:${provider}:${index}`, (draft) => {
                draft.providers[provider].fallbackModels = withSlot(
                  draft.providers[provider].fallbackModels,
                  index,
                  value.trim(),
                );
              });
            }),
        );
    }
  }

  private renderReviews(containerEl: HTMLElement): void {
    const name = this.settings.companion.name;
    const fictionMode = this.settings.persona.mode === "fiction";

    new Setting(containerEl).setName("Reviews").setHeading();
    new Setting(containerEl).setName("Style and focus").setHeading();

    new Setting(containerEl)
      .setName("What you are writing")
      .setDesc("Choose Fiction or Essays, articles and notes. This changes what Lyra looks for.")
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
              .then(() => this.refreshSettings());
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
      .setDesc(`On, ${name} speaks informally and in character. Off, she uses a plain, neutral voice.`)
      .addToggle((toggle) =>
        toggle.setValue(this.settings.persona.inCharacter).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.persona.inCharacter = value;
          });
        }),
      );

    new Setting(containerEl)
      .setName("How much she flags")
      .setDesc("Left, she flags only serious problems. Right, she includes smaller issues too.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setValue(this.settings.persona.pickiness)
          .onChange((value) => {
            void this.plugin.updateSettings((draft) => {
              draft.persona.pickiness = value;
            });
          }),
      );

    new Setting(containerEl)
      .setName("Say when something works")
      .setDesc("At most one compliment per reading, with a reason.")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.persona.praise).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.persona.praise = value;
          });
        }),
      );

    new Setting(containerEl)
      .setName("What she looks for")
      .setDesc("Write your own review guidance. Leave empty to use the default for the selected writing type.")
      .addTextArea((area) => {
        area.inputEl.rows = 5;
        area.inputEl.addClass("lyra-settings__focus");
        area
          .setPlaceholder(fictionMode ? DEFAULT_FICTION_FOCUS : DEFAULT_ESSAY_FOCUS)
          .setValue(this.settings.persona.focus)
          .onChange((value) => {
            this.saveWhenTypingPauses("focus", (draft) => {
              draft.persona.focus = value;
            });
          });
      });

    new Setting(containerEl).setName("Manual reviews").setHeading();

    let setFindingLimitDisabled = (_disabled: boolean): void => undefined;
    new Setting(containerEl)
      .setName("Manual review depth")
      .setDesc("Quick is one pass; deeper reviews add focused passes and broader checks.")
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
      .setName("Unlimited findings")
      .setDesc("Remove the finding-count cap for manual reviews. Request and time limits still apply.")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.manualReview.unlimitedFindings).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.manualReview.unlimitedFindings = value;
          });
          setFindingLimitDisabled(value);
        }),
      );

    new Setting(containerEl)
      .setName("Manual finding limit")
      .setDesc("Applies when unlimited findings is off.")
      .addSlider((slider) => {
        slider
          .setLimits(1, 20, 1)
          .setValue(this.settings.manualReview.maximumFindings)
          .setDisabled(this.settings.manualReview.unlimitedFindings)
          .onChange((value) => {
            void this.plugin.updateSettings((draft) => {
              draft.manualReview.maximumFindings = Math.round(value);
            });
          });
        setFindingLimitDisabled = (disabled) => slider.setDisabled(disabled);
      });

    new Setting(containerEl)
      .setName("Fact-check essay claims")
      .setDesc("Flags internal contradictions and claims that need sources. Lyra does not browse the web.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.settings.manualReview.factCheck)
          .setDisabled(fictionMode)
          .onChange((value) => {
            void this.plugin.updateSettings((draft) => {
              draft.manualReview.factCheck = value;
            });
          }),
      );

    new Setting(containerEl)
      .setName("Learn from review decisions")
      .setDesc("Manual reviews can use brief resolved or dismissed feedback from other notes in this folder or novel.")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.manualReview.learnFromFeedback).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.manualReview.learnFromFeedback = value;
          });
        }),
      );

    new Setting(containerEl).setName("Review comments").setHeading();

    const ignored = this.settings.ignoredCategories;
    if (ignored.length > 0) {
      const row = new Setting(containerEl)
        .setName("Topics she skips")
        .setDesc("Select a topic to let her raise it again.");

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
                .then(() => this.refreshSettings());
            }),
        );
      }
    }

    new Setting(containerEl)
      .setName("Underline commented passages")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.underline).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.underline = value;
          });
        }),
      );

    new Setting(containerEl).setName("Read along").setHeading();

    let setPauseDisabled = (_disabled: boolean): void => undefined;
    new Setting(containerEl)
      .setName("Read along as I write")
      .setDesc("On, Lyra reviews changed passages after a pause. Automatic story notes are controlled separately below.")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.liveReview.enabled).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.liveReview.enabled = value;
          });
          setPauseDisabled(!value);
        }),
      );

    new Setting(containerEl)
      .setName("Pause before a review")
      .setDesc("Seconds without typing before Lyra reviews the changed passage.")
      .addSlider((slider) => {
        slider
          .setLimits(SETTING_LIMITS.debounceMs.min / 1000, SETTING_LIMITS.debounceMs.max / 1000, 0.5)
          .setValue(this.settings.liveReview.debounceMs / 1000)
          .setDisabled(!this.settings.liveReview.enabled)
          .onChange((value) => {
            void this.plugin.updateSettings((draft) => {
              draft.liveReview.debounceMs = Math.round(value * 1000);
            });
          });
        setPauseDisabled = (disabled) => slider.setDisabled(disabled);
      });
  }

  private renderStoryAndMemory(containerEl: HTMLElement): void {
    const name = this.settings.companion.name;

    new Setting(containerEl).setName("Story and chat memory").setHeading();

    new Setting(containerEl)
      .setName("Keep notes on the story")
      .setDesc(`When enabled, ${name} reads changed chapters in folders with a story brief after a short pause and updates story notes. Chapter text is sent to your provider automatically, up to three chapters per pass.`)
      .addToggle((toggle) =>
        toggle.setValue(this.settings.story.keepNotes).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.story.keepNotes = value;
          });
        }),
      );

    new Setting(containerEl)
      .setName("Remember chats between sessions")
      .setDesc("On, saved chats and memory can be sent in later chats. Off, saved files remain locally but are not sent; new activity stays in memory until Obsidian closes.")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.story.rememberConversations).onChange((value) => {
          void this.plugin.updateSettings((draft) => {
            draft.story.rememberConversations = value;
          });
        }),
      );
  }

  private renderWindow(containerEl: HTMLElement): void {

    new Setting(containerEl).setName("Lyra’s window").setHeading();
    new Setting(containerEl).setName("Position and behavior").setHeading();

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
          .onChange((value) => {
            void this.plugin.updateSettings((draft) => {
              draft.companion.lingerSeconds = value;
            });
          }),
      );

    new Setting(containerEl).setName("Appearance").setHeading();

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
              .then(() => this.refreshSettings());
          }),
      );

  }
}
