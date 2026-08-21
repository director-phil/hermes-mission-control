/**
 * Goal Contract Parser and Validator - Slice 1 Implementation
 * 
 * Validates goal contracts before dispatch:
 * - Rejects malformed acceptance blocks with bash syntax errors
 * - Preserves raw acceptance bytes/heredocs
 * - Provides deterministic invalid reasons bounded to specific failure modes
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

export interface GoalContract {
  title: string | null;
  repoWorktree: string | null;
  dependencies: string[];
  hasAcceptance: boolean;
  acceptanceBody?: string; // Raw bytes preserved for validation
}

export interface ValidationResult {
  valid: boolean;
  invalidReason?: string;
  diagnostic?: string;
}

/**
 * Extract and validate goal contract from markdown body.
 * Returns parsed content with raw acceptance block preserved.
 */
export function extractGoalContract(body: string): GoalContract | null {
  const lines = body.split("\n");
  
  // Check frontmatter delimiter
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
  
  // Find acceptance block - preserve raw bytes
  let acceptanceBody: string | undefined;
  const hasAcceptance = body.includes("## Acceptance");
  
  if (hasAcceptance) {
    const acceptanceMatch = body.match(/## Acceptance\s+```bash([\s\S]*?)```/);
    if (acceptanceMatch && acceptanceMatch[1] !== undefined) {
      // Preserve raw bytes including heredocs, quotes, multiline commands
      acceptanceBody = acceptanceMatch[1];
    }
  }

  return {
    title: metadataString(metadata, "title"),
    repoWorktree: metadataString(metadata, "repo/workdir", "worktree", "repo"),
    dependencies: metadataList(metadata, "dependencies", "depends_on", "dependency_ids"),
    hasAcceptance,
    acceptanceBody,
  };
}

/**
 * Validate goal contract - returns valid=true or invalid reason with bounded diagnostic.
 */
export function validateGoalContract(contract: GoalContract | null): ValidationResult {
  if (!contract) {
    return { valid: false, invalidReason: "goal_invalid", diagnostic: "Missing or malformed frontmatter" };
  }

  // Rule: Must have exactly one acceptance block to be considered for dispatch
  if (!contract.hasAcceptance) {
    return { 
      valid: false, 
      invalidReason: "acceptance_contract_invalid", 
      diagnostic: "Goal contract lacks ## Acceptance block - cannot proceed to model dispatch" 
    };
  }

  // Rule: If acceptance block exists, validate bash syntax without executing
  if (contract.acceptanceBody !== undefined) {
    const validation = validateBashSyntax(contract.acceptanceBody);
    
    if (!validation.valid) {
      return {
        valid: false,
        invalidReason: "acceptance_contract_invalid",
        diagnostic: `Bash syntax error in acceptance block: ${validation.diagnostic}`,
      };
    }
  }

  // All validations passed
  return { valid: true };
}

/**
 * Validate bash syntax using 'bash -n' without executing postconditions.
 * Uses injectable subprocess adapter for testability.
 */
export function validateBashSyntax(acceptanceBody: string): ValidationResult {
  if (!acceptanceBody || acceptanceBody.trim().length === 0) {
    return { valid: false, invalidReason: "acceptance_contract_invalid", diagnostic: "Empty bash block" };
  }

  // Use bash -n (syntax check only, no execution)
  const result = spawnSync("/usr/bin/bash", ["-n", "-"], {
    input: acceptanceBody,
    encoding: "utf8",
    timeout: 5_000, // Bounded timeout
    maxBuffer: 64 * 1024, // Bounded buffer
  });

  if (result.error) {
    return { valid: false, invalidReason: "acceptance_contract_invalid", diagnostic: `Bash validator failed: ${result.error.message}` };
  }

  if (result.status !== 0) {
    // Parse bash error output - bounded to specific failure modes
    const stderr = result.stderr || result.stdout || "";
    
    // Extract the key error message
    let errorMessage = "Syntax error";
    if (stderr.includes("unexpected EOF")) {
      errorMessage = "unexpected EOF while looking for matching `)` or quote";
    } else if (stderr.includes("syntax error")) {
      const match = stderr.match(/syntax error near([^\\n]+)/);
      if (match) errorMessage = match[1].trim();
    } else if (stderr.includes("command not found")) {
      errorMessage = "command not found in acceptance block";
    }

    return { valid: false, invalidReason: "acceptance_contract_invalid", diagnostic: `Bash syntax error: ${errorMessage}` };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------\n
// Frontmatter parsing (shared with parseNativeGoalMarkdown logic)
// ---------------------------------------------------------------------------

type FrontmatterValue = string | string[];

function parseFrontmatter(lines: string[]): Record<string, FrontmatterValue> {
  const metadata: Record<string, FrontmatterValue> = {};
  let currentKey: string | null = null;
  
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    
    // List item continuation
    if (/^[ \\t]/.test(line) && currentKey && line.trim().startsWith("- ")) {
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
