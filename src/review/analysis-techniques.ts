import type { CommentCategory } from "../types";
import type { ReviewDepth } from "../types";
import type { WritingMode } from "../settings/settings";

interface Technique {
  id: string;
  modes: readonly WritingMode[];
  categories: readonly CommentCategory[];
  cue: string;
}

const TECHNIQUES: readonly Technique[] = [
  {
    id: "clarity",
    modes: ["fiction", "essay"],
    categories: ["clarity", "prose", "terminology"],
    cue: "Check ambiguous references, hidden steps, word echoes, and sentence rhythm that makes meaning harder to follow.",
  },
  {
    id: "mechanics",
    modes: ["fiction", "essay"],
    categories: ["grammar", "prose"],
    cue: "Check agreement, tense, modifiers, parallel structure, punctuation, and accidental repetition.",
  },
  {
    id: "argument",
    modes: ["essay"],
    categories: ["reasoning", "evidence", "structure", "fact"],
    cue: "Check claim and evidence fit, missing inference, scope, counterarguments, and conclusions that outrun their support.",
  },
  {
    id: "factual-precision",
    modes: ["essay"],
    categories: ["fact", "evidence", "consistency"],
    cue: "Separate internal contradiction, an unsupported claim, and a claim that needs external verification.",
  },
  {
    id: "scene-craft",
    modes: ["fiction"],
    categories: ["character", "dialogue", "pacing", "exposition", "emotion"],
    cue: "Check cause and effect, character knowledge and agency, scene beats, subtext, and whether the reader is emotionally carried through.",
  },
  {
    id: "narrative-control",
    modes: ["fiction"],
    categories: ["pov", "continuity", "character"],
    cue: "Check viewpoint knowledge, time and place transitions, names, physical state, objects, and promises already made to the reader.",
  },
  {
    id: "structure",
    modes: ["fiction", "essay"],
    categories: ["structure", "arc", "continuity"],
    cue: "Check ordering, transitions, setup and payoff, scope drift, and whether this section belongs where it is.",
  },
];

export function selectAnalysisTechniques(
  mode: WritingMode,
  enabled: readonly CommentCategory[],
  depth: ReviewDepth,
): string[] {
  const limit = depth === "quick" ? 2 : depth === "standard" ? 4 : 6;
  return TECHNIQUES
    .filter((item) => item.modes.includes(mode) && item.categories.some((category) => enabled.includes(category)))
    .slice(0, limit)
    .map((item) => `${item.id}: ${item.cue}`);
}
