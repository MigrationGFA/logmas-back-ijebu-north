/**
 * Central Local Government Area (LGA) Configuration — BACKEND
 *
 * Single source of truth for LGA-specific labels used by payment,
 * notification, and seeding code. Mirrors the frontend's
 * `logmas-ijebu-north/src/config/lga.config.ts` (identity subset).
 *
 * TO ONBOARD A NEW LGA (backend side):
 *   1. Either add a preset to LGA_PRESETS below, OR set the LGA_* env vars
 *      in `.env` (env vars always win; a preset is required only for the
 *      fields you leave out of env).
 *   2. Drop the services data file at `prisma/data/<LGA_ID>.services.json`
 *      (see `prisma/data/ijebu-north-east.services.json` for the format; use the
 *      `{lgaName}` token in descriptions so they follow the active LGA).
 *   3. Run `npm run prisma:migrate` and `npx prisma db seed`.
 *
 * NOTE: This module intentionally reads `process.env` directly (not `./env`)
 * so lightweight scripts can import it. `prisma/seed.ts` is excluded from the
 * backend tsconfig, so it reads the LGA_* env vars itself (same contract) to
 * avoid cross-directory imports.
 */

export interface LgaBackendConfig {
  /** Unique system identifier / slug (e.g. "ijebu-north-east", "kosofe"). Matches `prisma/data/<id>.services.json`. */
  id: string;
  /** Short common name (e.g. "Ijebu North East") — used in user-facing copy (emails, SMS, payment labels). */
  name: string;
  /** Full official council name (e.g. "Ijebu North East Local Government"). */
  fullName: string;
  /** Short code used in identifiers (e.g. "INE"). */
  shortCode: string;
  /** Prefix for gateway account labels (e.g. "IJEBUNORTHEAST" → "IJEBUNORTHEAST/INV-0001"). */
  accountPrefix: string;
}

/**
 * Known-LGA presets. Adding a new LGA here is OPTIONAL — every field can be
 * provided via env vars instead (LGA_ID, LGA_NAME, LGA_SHORT_CODE,
 * LGA_ACCOUNT_PREFIX). A preset simply keeps values in version control.
 */
const LGA_PRESETS: Record<string, LgaBackendConfig> = {
  "ijebu-north-east": {
    id: "ijebu-north-east",
    name: "Ijebu North East",
    fullName: "Ijebu North East Local Government",
    shortCode: "INE",
    accountPrefix: "IJEBUNORTHEAST",
  },
};

function resolveLgaConfig(): LgaBackendConfig {
  const id = process.env.LGA_ID?.trim() || "ijebu-north-east";
  const preset = LGA_PRESETS[id];

  const name = process.env.LGA_NAME?.trim() || preset?.name;
  if (!name) {
    throw new Error(
      `[lga.config] Unknown LGA_ID "${id}". Add a preset to LGA_PRESETS ` +
        `in src/config/lga.config.ts or set LGA_NAME in .env.`,
    );
  }

  const shortCode =
    process.env.LGA_SHORT_CODE?.trim() ||
    preset?.shortCode ||
    name.slice(0, 3).toUpperCase();

  return {
    id,
    name,
    fullName:
      process.env.LGA_FULL_NAME?.trim() ||
      preset?.fullName ||
      `${name} Local Government`,
    shortCode,
    accountPrefix:
      process.env.LGA_ACCOUNT_PREFIX?.trim() ||
      preset?.accountPrefix ||
      shortCode,
  };
}

/** Active LGA configuration for this deployment (env overrides presets). */
export const LGA_CONFIG: LgaBackendConfig = resolveLgaConfig();
