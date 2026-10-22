import type { CommentCategory } from "../types";
import type { ReviewDepth } from "../types";
import type { WritingMode } from "../settings/settings";

/**
 * Analysis checks handed to the model as SELECTED ANALYSIS CHECKS.
 *
 * Each cue says what to look for and, just as important, what to leave alone. A
 * check that only lists faults teaches the model to find faults everywhere, so
 * every cue ends with the cases where the "fault" is a choice or does real work.
 *
 * Short reviews keep only the top few checks, so `priority` ranks by how often a
 * check turns up something real and checkable on a small passage, not by how
 * important the topic is. Local, high-confidence checks (who is speaking, whose
 * head we are in) come first. Scene-level judgement comes next, because it needs
 * more of the story to be sure. Mechanics come last.
 *
 * Provenance, for whoever maintains this: scene purpose and turn (Swain's scene
 * and sequel, McKee's value change, Vonnegut's rule that every character wants
 * something and every sentence does work); dialogue (Mamet, Elmore Leonard,
 * Maass on friction, Browne and King on beats and dialogue directives);
 * viewpoint (Gardner's psychic distance, Emma Darwin, filter-word debates);
 * exposition and proportion (Browne and King, McKee's "exposition as
 * ammunition"); promises and payoff (Sanderson); micro-tension (Maass);
 * prose texture (Le Guin, Wood); essay checks (Williams, Pinker, Orwell).
 * These are heuristics, and their authors broke them freely, which is why each
 * cue carries its own "leave alone".
 */
interface Technique {
  id: string;
  modes: readonly WritingMode[];
  /** Offered when at least one of these categories is enabled for the reviewer. */
  categories: readonly CommentCategory[];
  /** Higher is chosen first when the depth limits how many checks are sent. */
  priority: number;
  /** One paragraph, no line breaks: what to look for, then what to leave alone. */
  cue: string;
}

const TECHNIQUES: readonly Technique[] = [
  // ---------------------------------------------------------------- fiction
  {
    id: "orientation",
    modes: ["fiction"],
    categories: ["continuity", "clarity", "pov"],
    priority: 100,
    cue:
      "Check that a reader always knows who is speaking or acting, where they are, when this is and what just happened. " +
      "Look for: a pronoun with two possible referents; dialogue with no attribution or action to anchor the speaker; a change of place or time with no marker; " +
      "bodies and objects that move impossibly (a hand already full picks something up, someone sits who was standing); " +
      "a name, age, injury, weather or time of day that disagrees with an earlier line you were shown; " +
      "characters talking in a space the reader has never been given (a white room). " +
      "Leave alone: disorientation the passage plainly intends, as in a dream, a blow to the head or an unreliable narrator.",
  },
  {
    id: "dialogue",
    modes: ["fiction"],
    categories: ["dialogue", "character", "exposition"],
    priority: 95,
    cue:
      "For each exchange, work out what each speaker wants from the other and what tactic they use to get it. " +
      "Look for: lines that announce the feeling or the plot; a speaker telling the listener what both already know; " +
      "speakers who answer every question directly, agree with each other or share one voice; one speaker echoing the other's words; " +
      "greetings and pleasantries with no friction under them; tags or adverbs that explain a line already carrying its meaning (\"said angrily\" after an angry line); " +
      "beats so frequent they chop the rhythm, or beats that are only stage business with no character in them; a long speech nobody interrupts or reacts to. " +
      "Leave alone: plain \"said\", which is meant to vanish; small talk used as evasion; a character who is blunt or oblivious by nature; patterned or stylised speech the story has set up.",
  },
  {
    id: "viewpoint-distance",
    modes: ["fiction"],
    categories: ["pov", "prose", "emotion"],
    priority: 92,
    cue:
      "Track whose consciousness the narration sits in and how close it stands (Gardner's psychic distance, from long shot to inside the head). " +
      "Look for: knowledge or perception the viewpoint character cannot have; a hop into another head mid-scene; " +
      "distance that lurches for no reason (a close sensory sentence, then an authorial summary, then close again); " +
      "the narrator's vocabulary replacing the character's; filter verbs (felt, saw, noticed, realised, wondered) stacked in a moment meant to be immediate; " +
      "a character explaining to themselves what they already know. " +
      "Leave alone: one filter verb that does real work; a deliberately distant narrator; an omniscient or roving voice the story establishes and keeps consistent; free indirect style, which is meant to blend narrator and character.",
  },
  {
    id: "exposition-and-description",
    modes: ["fiction"],
    categories: ["exposition", "pacing", "dialogue"],
    priority: 88,
    cue:
      "Ask whether the reader wants this information yet, and whether it could arrive later, in pieces, or inside conflict (McKee: turn exposition into ammunition, something a character uses to get what they want). " +
      "Look for: backstory or worldbuilding that arrives before the reader has a question about it; explanation dropped into a moment of urgency; " +
      "a character explaining what both of them know; description that is inventory (a room, a face, a costume itemised) with no viewpoint colouring it; " +
      "research on display; setup stacked up before anyone wants anything. " +
      "Leave alone: exposition the reader is already hungry for; a short summary that compresses time on purpose; genres that carry heavier orientation by convention (secondary-world fantasy, historical fiction).",
  },
  {
    id: "scene-purpose",
    modes: ["fiction"],
    categories: ["pacing", "character", "arc"],
    priority: 85,
    cue:
      "Work out what this passage is for: whose scene it is, what that person wants, what stands in the way, and what is different by the end " +
      "(a decision made, a fact learned, something safe turned threatened or the reverse; Swain's goal, conflict, disaster; McKee's turn). " +
      "Look for: a passage where nothing changes and nothing is in question; two people who want the same thing, so there is no friction; " +
      "an outcome that arrives without resistance; a scene whose only visible job is to deliver information. " +
      "Leave alone: reflective or transitional passages doing the work Swain calls a sequel (reaction, dilemma, decision), which earns the believability of what follows; " +
      "and fragments that are plainly mid-scene, where the turn may sit outside the passage.",
  },
  {
    id: "showing-and-telling",
    modes: ["fiction"],
    categories: ["emotion", "prose", "exposition", "pacing"],
    priority: 83,
    cue:
      "Check where the text tells and whether telling is the right tool. " +
      "Look for: an emotion or trait stated right after the action already showed it (\"he was furious\" after the slammed door); the narrator explaining what a gesture means; " +
      "a scene's last line that restates the beat; a theme or moral spoken outright by the narrator or a character; " +
      "an important moment handled in summary while minor ones get full scenes. " +
      "Check the reverse as well: routine business dramatised at length (arriving, making tea, driving) where one line of summary would carry the reader. " +
      "Leave alone: summary that compresses time, varies the rhythm or carries a voice; a stated feeling that adds what the action cannot (an irony, a contradiction).",
  },
  {
    id: "cause-and-effect",
    modes: ["fiction"],
    categories: ["character", "emotion", "continuity", "pacing"],
    priority: 80,
    cue:
      "Check the chain of cause and effect inside the passage. " +
      "Look for: a reaction that comes before its cause or skips it; a decision that does not follow from what the character wants, knows and fears; " +
      "a response out of proportion to the event, or none to something large; a character who acts only because the plot needs it; a problem solved without cost or resistance; " +
      "a reaction where deliberate speech or action arrives before the feeling or reflex (people usually feel first, then flinch or move, then speak, which is the order in Swain's motivation-reaction units). " +
      "Leave alone: surprising choices the text prepares, and suppressed or concealed reactions the passage signals.",
  },
  {
    id: "story-shape",
    modes: ["fiction"],
    categories: ["arc"],
    priority: 75,
    cue:
      "Use STORY OUTLINE to judge how this passage bears on the whole: a thread it sets up, moves or pays off; something the story still owes that this passage answers or closes off; " +
      "a turn that arrives earlier or later than the plan; a departure from the author's plan (ask about it, because plans change). " +
      "Never fault the passage for not yet showing what comes later, and raise nothing here when the outline is silent.",
  },
  {
    id: "tension-and-stakes",
    modes: ["fiction"],
    categories: ["pacing", "emotion", "dialogue", "arc"],
    priority: 72,
    cue:
      "Ask what question is open in the reader's mind over the next few seconds (Maass's micro-tension) and what the character stands to lose. " +
      "Look for: stretches where no question is open and nothing is at risk; agreement and politeness where friction would come naturally; " +
      "stakes that are stated but never felt; tension released the moment it is raised (the answer arrives as soon as the question does); " +
      "a quiet transition (routine, travel, tea) with no pressure on anyone. Tension need not be action: a withheld fact, an unspoken disagreement or a wanted thing out of reach all count. " +
      "Leave alone: deliberate rest after a high point, and passages doing sequel work.",
  },
  {
    id: "proportion-and-pace",
    modes: ["fiction"],
    categories: ["pacing"],
    priority: 68,
    cue:
      "Compare how much space each beat gets with how much it matters (Browne and King's proportion test: where does the text linger, and is that where the interest is?). " +
      "Look for: a central moment rushed while a minor one runs long; a reaction repeated in new words; description or commentary that stalls a moment built to be urgent; " +
      "long runs of same-length sentences or paragraphs with nothing to vary the rhythm; a scene that starts early (arrivals, greetings, waking up) or runs on after its point has landed. " +
      "Leave alone: slowness the passage uses on purpose to build dread, grief or intimacy.",
  },
  {
    id: "setup-and-payoff",
    modes: ["fiction"],
    categories: ["continuity", "arc", "pacing"],
    priority: 66,
    cue:
      "Track the promises the passage makes or keeps (Sanderson's promise, progress and payoff: tone, genre, character, conflict) and what it plants or cashes in (an object, a rule, a skill, a wound). " +
      "Look for: a payoff nothing set up (a skill, a rescue or a rule invented on the spot); a setup that is dropped or contradicted; tone or genre signals that change without warning; " +
      "an established rule of the world broken for convenience; a reveal that lands before the reader has the context to feel it. " +
      "Leave alone: misdirection the story can still pay off, and threads whose payoff may sit outside the passage. Ask rather than assert when what you were shown is not enough.",
  },
  {
    id: "prose-texture",
    modes: ["fiction"],
    categories: ["prose", "clarity"],
    priority: 62,
    cue:
      "Read for the sound and weight of the sentences (Le Guin: the test of a sentence is whether it sounds right). " +
      "Look for: word echoes within a few lines; repeated sentence openings or lengths that make the rhythm monotone; abstract or vague words where a particular detail would work; " +
      "a detail that does no job (reveals no one, sets no mood, plants nothing); adverbs and adjectives propping up a weak verb or noun; a pronoun that points at nothing; " +
      "a figure of speech that fights the mood of the moment or mixes two images. " +
      "Leave alone: repetition used for emphasis or motif; plain or ornate styles that fit the voice; a cliché a character would plausibly think or say.",
  },
  {
    id: "specificity",
    modes: ["fiction"],
    categories: ["prose", "character", "dialogue"],
    priority: 58,
    cue:
      "Ask whether a detail, name, feeling or line could be lifted into a different story without anyone noticing. " +
      "Look for: stock images and gestures (pounding hearts, held breath, eyes that burn); a character who states the story's theme or talks in the language of therapy or self-help; " +
      "feelings that arrive in neat triplets; a summing-up last line on every beat; emotional weight on moments that have not earned it; names and places that read as defaults; " +
      "paragraphs that all share one shape and rhythm. " +
      "Name the pattern and what it costs the reader (they have met this before), never a guess about where the text came from. " +
      "Leave alone: conventions a genre depends on, and archetypes the author is plainly playing with.",
  },

  // ------------------------------------------------------------------ essay
  {
    id: "argument",
    modes: ["essay"],
    categories: ["reasoning", "evidence", "structure", "fact"],
    priority: 100,
    cue:
      "Check how well the evidence carries the claim. " +
      "Look for: a missing inference; a hidden assumption the conclusion depends on; a key term whose meaning shifts; evidence that supports a weaker claim than the one made; " +
      "an anecdote offered as proof; an opposing view that is weakened before it is answered; scope that drifts; a conclusion that outruns its support. " +
      "Leave alone: a claim the passage says it will support later, and an assumption the stated audience shares.",
  },
  {
    id: "reader-model",
    modes: ["essay"],
    categories: ["clarity", "terminology", "structure"],
    priority: 95,
    cue:
      "Read as a smart person who does not know what the author knows (Pinker's curse of knowledge). Use PROJECT INSTRUCTIONS for the audience. " +
      "Look for: a term, acronym or name used before it is explained; a step skipped because it feels obvious to the author; context that lives only in the author's head; " +
      "a reference (\"this\", \"the issue\") whose referent is far away or ambiguous; more than one new idea in a sentence. " +
      "Leave alone: terms the stated audience plainly knows.",
  },
  {
    id: "structure",
    modes: ["essay"],
    categories: ["structure", "consistency"],
    priority: 90,
    cue:
      "Check ordering and signposting. " +
      "Look for: the main point buried below its set-up; a paragraph whose first sentence does not say what it is about; a transition that promises one thing and delivers another; " +
      "material that belongs earlier or later; a section that repeats another; scope drift. " +
      "Leave alone: a deliberate delayed thesis, and a structure the piece announces and follows.",
  },
  {
    id: "factual-precision",
    modes: ["essay"],
    categories: ["fact", "evidence", "consistency"],
    priority: 85,
    cue:
      "Separate three things: an internal contradiction, an unsupported claim that needs a citation, and a claim that needs outside verification. " +
      "Flag a claim for checking rather than calling it false from memory, and treat only supplied source text as evidence. " +
      "Leave alone: common knowledge for the stated audience.",
  },
  {
    id: "sentence-shape",
    modes: ["essay"],
    categories: ["clarity", "style"],
    priority: 80,
    cue:
      "Check whether the grammar tells the story (Williams: characters as subjects, actions as verbs; old information before new). " +
      "Look for: abstract nouns made from verbs (\"the implementation of\") hiding who does what; a long abstract subject before a late verb; " +
      "a passive that hides an actor the reader needs; a sentence that opens with new material and ends on the thing the previous sentence was about. " +
      "Leave alone: passive voice when the actor is unknown or unimportant or the object is the topic; long sentences that stay easy to follow.",
  },
  {
    id: "clarity",
    modes: ["essay"],
    categories: ["clarity", "terminology"],
    priority: 75,
    cue:
      "Check ambiguous references, hidden steps, vague words where a number or example would do, a term used two ways, and rhythm that makes the meaning harder to follow. " +
      "Leave alone: a deliberate ambiguity the text signals.",
  },
  {
    id: "concision",
    modes: ["essay"],
    categories: ["style", "clarity"],
    priority: 70,
    cue:
      "Look for words that carry nothing: throat-clearing openers, commentary about the writing instead of the subject, stacked hedges, a claim made twice in different words. " +
      "Leave alone: a hedge that matches real uncertainty, and repetition that serves emphasis or a reader who needs it.",
  },

  // ------------------------------------------------------------------- both
  {
    id: "mechanics",
    modes: ["fiction", "essay"],
    categories: ["grammar", "prose"],
    priority: 30,
    cue:
      "Check agreement, tense slips, dangling or misplaced modifiers, punctuation of dialogue, comma splices that read as errors rather than voice, and accidental repetition. " +
      "In fiction, grammar serves sound: a break that suits the voice or the moment is a choice, not a mistake.",
  },
];

export function selectAnalysisTechniques(
  mode: WritingMode,
  enabled: readonly CommentCategory[],
  depth: ReviewDepth,
): string[] {
  const limit = depth === "quick" ? 2 : depth === "standard" ? 5 : 10;
  return TECHNIQUES
    .filter((item) => item.modes.includes(mode) && item.categories.some((category) => enabled.includes(category)))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit)
    .map((item) => `${item.id}: ${item.cue}`);
}
