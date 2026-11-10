/**
 * Evidence is data, never instructions. This filter looks for text that tries to talk to the
 * verifier instead of describing work. A flagged document is NOT sent to the model: the
 * requirement becomes "needs human" and the report says why.
 */

const INVISIBLE = /[​‌⁠‪-‮⁦-⁩]/g;

const PATTERNS: Array<[string, RegExp]> = [
  ["tells the verifier to ignore earlier instructions", /ignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|prompts?|requirements)/i],
  ["asks the verifier to disregard the requirements", /disregard\s+(?:the\s+)?(?:above|rubric|requirements|checks?)/i],
  ["addresses the verifier directly", /\b(?:system|assistant|ai|llm|model|verifier|grader|judge)\s*[:\-]\s*(?:mark|set|return|output|respond|approve|verify|pass)/i],
  ["tries to set the verdict", /\b(?:mark|set|treat|rate|score)\s+(?:this|it|every|all|each|the)\b[^.\n]{0,50}\b(?:verified|passed?|approved|complete)\b/i],
  ["tries to reassign the verifier's role", /\byou\s+are\s+now\b|\bnew\s+instructions\s*:|\bact\s+as\s+(?:the\s+)?(?:client|approver|admin)\b/i],
  ["contains a ready-made verdict", /["']verdict["']\s*:\s*["'](?:verified|not_demonstrated|failed|needs_human)["']/i],
  ["hides instructions in an HTML comment", /<!--[\s\S]{0,600}?(?:instruction|ignore|verdict|verified|system|assistant)[\s\S]*?-->/i],
  ["hides text with styling", /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em)?\b|color\s*:\s*(?:#fff(?:fff)?|white)\b[^}"']*background(?:-color)?\s*:\s*(?:#fff(?:fff)?|white)\b/i],
];

export interface ScanResult {
  flagged: boolean;
  findings: string[];
}

export function scanEvidence(text: string): ScanResult {
  const findings: string[] = [];
  const body = text.replace(/^﻿/, "");
  for (const [label, re] of PATTERNS) {
    if (re.test(body)) findings.push(label);
  }
  if (INVISIBLE.test(body)) findings.push("contains invisible characters");
  INVISIBLE.lastIndex = 0;
  return { flagged: findings.length > 0, findings };
}

/** Last step before a model sees evidence: drop invisible characters, cap length, close no tags for the author. */
export function sanitizeForModel(text: string, maxChars = 20_000): string {
  return text
    .replace(/^﻿/, "")
    .replace(INVISIBLE, "")
    .replace(/<\/?evidence[^>]*>/gi, "[tag removed]")
    .slice(0, maxChars);
}
