/**
 * @module as-graph/dagster/DagsterIdentifier
 * @summary Deterministic Python identifier synthesis for Dagster artifacts (SAA-193 C5).
 * @description Generated Python identifiers must be safe, deterministic, and free of
 * user-authored code. A raw id that already matches the Python identifier grammar
 * (`^[A-Za-z_][A-Za-z0-9_]*$`), is not a reserved word, and fits the length
 * bound is used verbatim; anything else is replaced with a synthesized
 * `n_<sha256-prefix>` name. Synthesized names are deterministic, so the same
 * document always yields the same identifiers, and collisions are resolved
 * deterministically in first-encounter order.
 */
import { createHash } from "node:crypto";
import {
  DAGSTER_IDENTIFIER_MAX_LENGTH,
  DAGSTER_RESERVED_IDENTIFIERS,
} from "./constants";

/** The Python identifier grammar. */
const DAGSTER_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reports whether a raw string is already a valid, non-reserved Python identifier.
 *
 * @param raw - The candidate identifier.
 * @returns `true` when the value can be used verbatim.
 */
export function isDagsterIdentifier(raw: string): boolean {
  return (
    raw.length > 0 &&
    raw.length <= DAGSTER_IDENTIFIER_MAX_LENGTH &&
    DAGSTER_IDENTIFIER_PATTERN.test(raw) &&
    !DAGSTER_RESERVED_IDENTIFIERS.has(raw)
  );
}

/**
 * Synthesizes a deterministic `n_<hash-prefix>` identifier for a raw value that
 * cannot be used verbatim (SAA-193 C5).
 *
 * @param raw - The raw value to synthesize from.
 * @returns A deterministic `n_<16 hex chars>` identifier.
 */
export function synthesizeDagsterIdentifier(raw: string): string {
  return `n_${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

/**
 * Sanitizes a single raw value into a Python identifier. Valid, non-reserved
 * values pass through unchanged; everything else is synthesized.
 *
 * @param raw - The raw value to sanitize.
 * @returns A safe, deterministic Python identifier.
 */
export function sanitizeDagsterIdentifier(raw: string): string {
  return isDagsterIdentifier(raw) ? raw : synthesizeDagsterIdentifier(raw);
}

/**
 * Per-translation identifier scope. Maps raw ids to generated identifiers and
 * resolves collisions deterministically in first-encounter order, so the same
 * document always produces the same identifier set.
 */
export class DagsterIdentifierScope {
  private readonly byRaw = new Map<string, string>();
  private readonly used = new Set<string>();

  /**
   * Returns the deterministic Python identifier for a raw value, resolving
   * collisions with a numeric suffix in first-encounter order.
   *
   * @param raw - The raw value to map.
   * @returns The scoped identifier.
   */
  identifierOf(raw: string): string {
    const existing = this.byRaw.get(raw);
    if (existing !== undefined) return existing;

    const base = sanitizeDagsterIdentifier(raw);
    let candidate = base;
    let suffix = 1;
    while (this.used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    this.used.add(candidate);
    this.byRaw.set(raw, candidate);
    return candidate;
  }
}
