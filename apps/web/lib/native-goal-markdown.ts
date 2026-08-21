export interface ParsedNativeGoalMarkdown {
  title: string | null;
  repoWorktree: string | null;
  dependencies: string[];
  hasAcceptance: boolean;
}

type FrontmatterValue = string | string[];

import { extractGoalContract } from "@/../../bridge/goal_contract";

export function parseNativeGoalMarkdown(body: string): ParsedNativeGoalMarkdown | null {
  const lines = body.split("\n");
  if (lines[0]?.trim() !== "---") return null;

  const fmLines: string[] = [];
  let closedFrontmatter = false;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") {
      closedFrontmatter = true;
      break;
    }
    fmLines.push(line);
  }
  if (!closedFrontmatter) return null;

  const metadata = parseFrontmatter(fmLines);

  // Use goal_contract module for comprehensive validation
  const contract = extractGoalContract(body);
  const hasAcceptance = Boolean(contract?.hasAcceptance);

  return {
    title: metadataString(metadata, "title"),
    repoWorktree: metadataString(metadata, "repo/workdir", "worktree", "repo"),
    dependencies: metadataList(metadata, "dependencies", "depends_on", "dependency_ids"),
    hasAcceptance,
  };
}

function parseFrontmatter(lines: string[]): Record<string, FrontmatterValue> {
  const metadata: Record<string, FrontmatterValue> = {};
  let currentKey: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^[ \t]/.test(line) && currentKey && line.trim().startsWith("- ")) {
      const existing = metadata[currentKey];
      const list = Array.isArray(existing) ? existing : [];
      list.push(cleanYamlScalar(line.trim().slice(2).trim()));
      metadata[currentKey] = list;
      continue;
    }
    currentKey = null;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!key) continue;
    currentKey = key;
    if (value === "") {
      metadata[key] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      metadata[key] = value.slice(1, -1).split(",").map((item) => cleanYamlScalar(item.trim())).filter(Boolean);
    } else {
      metadata[key] = cleanYamlScalar(value);
    }
  }
  return metadata;
}

function cleanYamlScalar(value: string): string {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function metadataString(metadata: Record<string, FrontmatterValue>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key.toLowerCase()];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function metadataList(metadata: Record<string, FrontmatterValue>, ...keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = metadata[key.toLowerCase()];
    if (Array.isArray(value)) {
      values.push(...value.map((item) => item.trim()).filter(Boolean));
    } else if (typeof value === "string") {
      values.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
    }
  }
  return values;
}
