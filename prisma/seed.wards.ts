import { PrismaClient } from "@prisma/client";

import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";

// ───────────────────────────────────────────────────────────────────────────
// Ward seeding (standalone)
//
// Run on its own when only the wards should be seeded, e.g. production,
// where the services already exist:
//
//   npm run seed:wards
//
// Wards live in `prisma/data/<LGA_ID>.wards.json` and are upserted by
// code, so re-running is safe. A clone without a wards file skips
// quietly. The combined `prisma/seed.ts` imports seedWards from here.
// ───────────────────────────────────────────────────────────────────────────

const lgaId = process.env.LGA_ID?.trim() || "ijebu-north-east";
const lgaName = process.env.LGA_NAME?.trim() || lgaId;

interface SeedWard {
  name: string;
  code: string;
  description?: string;
}

function loadWards(): SeedWard[] {
  const filePath = join(__dirname, "data", `${lgaId}.wards.json`);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    console.log(`[seed] No wards file for LGA "${lgaId}", skipping wards.`);
    return [];
  }
  return JSON.parse(raw) as SeedWard[];
}

export async function seedWards(prisma: PrismaClient) {
  const wards = loadWards();
  if (wards.length === 0) return;

  console.log(` Seeding ${wards.length} wards for ${lgaName} (${lgaId})...`);
  for (const w of wards) {
    await prisma.ward.upsert({
      where: { code: w.code },
      update: { name: w.name, description: w.description ?? null },
      create: {
        name: w.name,
        code: w.code,
        description: w.description ?? null,
      },
    });
    console.log(`✅ Ward ${w.code} → ${w.name}`);
  }
}

if (require.main === module) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  seedWards(prisma)
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
      await pool.end();
    });
}
