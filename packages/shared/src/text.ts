export function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/\bby mouth\b/g, "po")
    .replace(/\btwice daily\b|\btwo times daily\b/g, "bid")
    .replace(/\bonce daily\b|\bevery day\b/g, "daily")
    .replace(/\bthree times daily\b/g, "tid")
    .replace(/\bfour times daily\b/g, "qid")
    .replace(/\bevery 6 hours\b/g, "q6h")
    .replace(/\bevery six hours\b/g, "q6h")
    .replace(/(\d+)\s+mg/g, "$1mg")
    .replace(/[^a-z0-9./%]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value: string): Set<string> {
  return new Set(normalizeText(value).split(" ").filter(Boolean));
}

export function tokenSetRatio(left: string | null | undefined, right: string | null | undefined): number {
  const a = tokens(left ?? "");
  const b = tokens(right ?? "");
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  const precision = overlap / a.size;
  const recall = overlap / b.size;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export function exactish(left: string | null | undefined, right: string | null | undefined): boolean {
  return normalizeText(left) === normalizeText(right);
}

export function bestFuzzy(value: string, candidates: string[]): number {
  return candidates.reduce((best, candidate) => Math.max(best, tokenSetRatio(value, candidate)), 0);
}
