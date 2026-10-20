import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = path.join(root, "tests", "fixtures", "review-eval-corpus.json");
const selfTest = process.argv.includes("--self-test");
const resultPath = selfTest
  ? path.join(root, "tests", "fixtures", "review-eval-smoke-results.json")
  : process.argv[2] === undefined
    ? undefined
    : path.resolve(process.argv[2]);

if (resultPath === undefined) {
  process.stderr.write("Usage: node scripts/review-eval.mjs <results.json> | --self-test\n");
  process.exitCode = 2;
} else {
  const [corpus, results] = await Promise.all([
    readJson(corpusPath),
    readJson(resultPath),
  ]);
  const report = evaluate(corpus, results);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (selfTest && (report.precision !== 1 || report.recall !== 1 || report.duplicateRate !== 0 || report.settledReappearances !== 0)) {
    process.exitCode = 1;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function evaluate(corpus, results) {
  const byId = new Map(results.map((entry) => [entry.caseId, entry]));
  let expectedCount = 0;
  let predictedCount = 0;
  let truePositives = 0;
  let exactQuotes = 0;
  let accurateSeverities = 0;
  let validAnchors = 0;
  let duplicateCount = 0;
  let settledReappearances = 0;
  let noCommentFalsePositives = 0;
  let latencyMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCost = 0;
  let costReports = 0;
  const categories = {};
  const cases = [];

  for (const sample of corpus) {
    const prediction = byId.get(sample.id);
    const comments = Array.isArray(prediction?.comments) ? prediction.comments : [];
    latencyMs += finite(prediction?.latencyMs);
    inputTokens += finite(prediction?.usage?.inputTokens);
    outputTokens += finite(prediction?.usage?.outputTokens);
    if (typeof prediction?.estimatedCost === "number" && Number.isFinite(prediction.estimatedCost)) {
      estimatedCost += prediction.estimatedCost;
      costReports += 1;
    }
    const expected = sample.issues;
    expectedCount += expected.length;
    predictedCount += comments.length;
    const matched = new Set();
    const seen = new Set();
    let caseTrue = 0;

    for (const comment of comments) {
      const key = `${comment.category}:${normalize(comment.quote)}`;
      if (seen.has(key)) duplicateCount += 1;
      seen.add(key);
      if ((sample.settled ?? []).some((issue) => issue.category === comment.category && overlaps(issue.quote, comment.quote))) {
        settledReappearances += 1;
      }
      const start = typeof comment.quote === "string" ? sample.text.indexOf(comment.quote) : -1;
      if (start >= 0) validAnchors += 1;
      const index = expected.findIndex((issue, candidate) =>
        !matched.has(candidate) && issue.category === comment.category && overlaps(issue.quote, comment.quote),
      );
      if (index < 0) continue;
      matched.add(index);
      caseTrue += 1;
      truePositives += 1;
      if (expected[index].quote === comment.quote) exactQuotes += 1;
      if (expected[index].severity === comment.severity) accurateSeverities += 1;
      categories[expected[index].category] = (categories[expected[index].category] ?? 0) + 1;
    }

    const missed = expected.length - matched.size;
    if (expected.length === 0 && comments.length > 0) noCommentFalsePositives += comments.length;
    cases.push({ id: sample.id, expected: expected.length, predicted: comments.length, matched: caseTrue, missed });
  }

  const precision = ratio(truePositives, predictedCount);
  const recall = ratio(truePositives, expectedCount);
  return {
    precision,
    recall,
    exactQuoteAccuracy: ratio(exactQuotes, truePositives),
    anchorAccuracy: ratio(validAnchors, predictedCount),
    duplicateRate: ratio(duplicateCount, predictedCount),
    settledReappearances,
    noCommentFalsePositives,
    severityAccuracy: ratio(accurateSeverities, truePositives),
    matchedByCategory: categories,
    latencyMs: latencyMs || null,
    usage: inputTokens + outputTokens === 0 ? null : { inputTokens, outputTokens },
    estimatedCost: costReports === 0 ? null : Number(estimatedCost.toFixed(6)),
    cases,
    note: "Unsupported assertions and usefulness still need human review.",
  };
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function overlaps(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = new Set(normalize(left).split(" ").filter(Boolean));
  const b = new Set(normalize(right).split(" ").filter(Boolean));
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size) >= 0.5;
}

function normalize(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";
}

function ratio(part, whole) {
  return whole === 0 ? 1 : Number((part / whole).toFixed(4));
}
