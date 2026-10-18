import type { CompanionMood, Scene } from "./lines";
import { ACTIVE_REACTION_CATALOG, ACTIVE_REACTION_IDS } from "../types";

export type SceneMode = "active" | "passive";

export interface SceneActivity {
  talking: boolean;
  answering: boolean;
  discussing: boolean;
  noteInteracting: boolean;
  activity: "idle" | "waiting" | "reading" | "error";
}

export interface LyraSceneAsset {
  id: string;
  asset: string;
}

const ASSETS = {
  idle_happy_resting: { id: "idle_happy_resting", asset: "idle/idle_happy_resting.webp" },
  idle_happy: { id: "idle_happy", asset: "idle/idle_happy.webp" },
  idle_concerned: { id: "idle_concerned", asset: "idle/idle_concerned.webp" },
  idle_embarassed: { id: "idle_embarassed", asset: "idle/idle_embarassed.webp" },
  idle_goodbye: { id: "idle_goodbye", asset: "idle/idle_goodbye.webp" },
  idle_laughing: { id: "idle_laughing", asset: "idle/idle_laughing.webp" },
  idle_sad: { id: "idle_sad", asset: "idle/idle_sad.webp" },
  idle_serious: { id: "idle_serious", asset: "idle/idle_serious.webp" },
  idle_shocked_happy: { id: "idle_shocked_happy", asset: "idle/idle_shocked_happy.webp" },
  idle_shocked_sad: { id: "idle_shocked_sad", asset: "idle/idle_shocked_sad.webp" },
  idle_sulking: { id: "idle_sulking", asset: "idle/idle_sulking.webp" },
  idle_teasing: { id: "idle_teasing", asset: "idle/idle_teasing.webp" },
  idle_welcome: { id: "idle_welcome", asset: "idle/idle_welcome.webp" },
  passive_listening_to_music: { id: "passive_listening_to_music", asset: "idle/passive_listening_to_music.webp" },
} as const satisfies Record<string, LyraSceneAsset>;

const IN_PROGRESS_SCENES: readonly LyraSceneAsset[] = [1, 2, 3, 4, 5].map((number) => ({
  id: `in_progress_${number}`,
  asset: `in_progress/in_progress_${number}.webp`,
}));

const PASSIVE_ACTIVITY_SCENES: readonly LyraSceneAsset[] = [
  "passive_gaming",
  "passive_guitar",
  "passive_looking_at_window",
  "passive_lying_down",
  "passive_mirror",
  "passive_picking_up_book",
  "passive_reading_lying_down",
  "passive_reading_on_bed",
  "passive_sleeping_on_desk",
  "passive_sorting_cds",
].map((id) => ({ id, asset: `idle/${id}.webp` }));

export type LyraSceneAssetId = keyof typeof ASSETS;

/** Casual idle expressions; reaction and greeting poses stay in the active set. */
export const PASSIVE_SCENES: readonly LyraSceneAsset[] = [
  ASSETS.idle_happy_resting,
  ASSETS.idle_happy,
  ASSETS.idle_embarassed,
  ASSETS.idle_sad,
  ASSETS.idle_sulking,
  ASSETS.idle_teasing,
  ASSETS.passive_listening_to_music,
  ...PASSIVE_ACTIVITY_SCENES,
];

/** Only original-design assets are used while she is active. */
export const ACTIVE_SCENES: readonly LyraSceneAsset[] = ACTIVE_REACTION_IDS.map((id) => ASSETS[id]);

/** The only sprite choices exposed to AI prompts; cues describe expressions, not image data. */
export function reactionCatalogText(): string {
  return ACTIVE_REACTION_IDS.map((id) => `- ${id}: ${ACTIVE_REACTION_CATALOG[id]}`).join("\n");
}

const ACTIVE_BY_MOOD: Record<CompanionMood, readonly LyraSceneAssetId[]> = {
  resting: ["idle_serious", "idle_concerned"],
  waiting: ["idle_serious", "idle_concerned"],
  reading: ["idle_serious", "idle_concerned"],
  pointed: ["idle_concerned", "idle_serious", "idle_shocked_sad"],
  asking: ["idle_concerned", "idle_serious", "idle_shocked_sad"],
  answering: ["idle_serious", "idle_concerned"],
  surprised: ["idle_shocked_sad", "idle_concerned", "idle_shocked_happy"],
  happy: ["idle_shocked_happy", "idle_laughing", "idle_welcome"],
  excited: ["idle_goodbye", "idle_welcome", "idle_laughing"],
  amused: ["idle_laughing", "idle_shocked_happy"],
  sad: ["idle_concerned", "idle_shocked_sad"],
  greeting: ["idle_welcome", "idle_goodbye"],
};

const ACTIVE_BY_TALK_SCENE: Record<Scene, readonly LyraSceneAssetId[]> = {
  listening: ["idle_serious", "idle_concerned"],
  sipping: ["idle_serious", "idle_laughing"],
  window: ["idle_serious", "idle_concerned", "idle_welcome"],
  watering: ["idle_serious", "idle_concerned"],
  strolling: ["idle_serious", "idle_concerned", "idle_goodbye"],
  writing: ["idle_serious", "idle_concerned"],
  reading: ["idle_serious", "idle_concerned"],
  typing: ["idle_serious", "idle_concerned"],
  shelf: ["idle_concerned", "idle_serious", "idle_shocked_sad"],
  pondering: ["idle_concerned", "idle_serious", "idle_shocked_sad"],
  winking: ["idle_shocked_happy", "idle_laughing"],
  laughing: ["idle_laughing", "idle_shocked_happy"],
  stretching: ["idle_goodbye", "idle_serious"],
  tired: ["idle_shocked_sad", "idle_concerned"],
  waving: ["idle_welcome", "idle_goodbye"],
};

export function sceneMode(activity: SceneActivity): SceneMode {
  return activity.talking || activity.answering || activity.discussing || activity.noteInteracting ||
    activity.activity === "waiting" || activity.activity === "reading"
    ? "active"
    : "passive";
}

export function activeSceneOptions(mood: CompanionMood, preferred?: Scene): readonly LyraSceneAsset[] {
  const ids = preferred === undefined ? ACTIVE_BY_MOOD[mood] : ACTIVE_BY_TALK_SCENE[preferred];
  return ids.map((id) => ASSETS[id]);
}

/** Randomizes a scene pool without repeating until every candidate has appeared. */
export class SceneRotation {
  private remaining: LyraSceneAsset[] = [];
  private poolKey = "";
  private previousId: string | null = null;

  next(scenes: readonly LyraSceneAsset[], random: () => number = Math.random): LyraSceneAsset {
    const key = scenes.map((scene) => scene.id).sort().join("|");
    if (key !== this.poolKey || this.remaining.length === 0) this.refill(scenes, key, random);

    const selected = this.remaining.pop()!;
    this.previousId = selected.id;
    return selected;
  }

  private refill(scenes: readonly LyraSceneAsset[], key: string, random: () => number): void {
    this.poolKey = key;
    this.remaining = [...scenes];
    for (let index = this.remaining.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [this.remaining[index], this.remaining[other]] = [this.remaining[other]!, this.remaining[index]!];
    }

    const last = this.remaining.length - 1;
    if (last > 0 && this.remaining[last]?.id === this.previousId) {
      [this.remaining[last], this.remaining[last - 1]] = [this.remaining[last - 1]!, this.remaining[last]!];
    }
  }
}

export const PASSIVE_ASSETS = PASSIVE_SCENES;
export const IN_PROGRESS_ASSETS = IN_PROGRESS_SCENES;
