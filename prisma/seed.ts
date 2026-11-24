import { PrismaClient } from "@prisma/client";

import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import "dotenv/config";

import { seedWards } from "./seed.wards";
import { seedServices } from "./seed.services";

// ───────────────────────────────────────────────────────────────────────────
// Combined seed (the `prisma db seed` entry point)
//
// Runs every seed in order: wards first, then the service catalog.
// Each part also runs on its own, which is what production deploys use
// when only one part should be seeded:
//
//   npm run seed:wards      wards only
//   npm run seed:services   services and fee configs only
// ───────────────────────────────────────────────────────────────────────────

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

async function main() {
  await seedWards(prisma);
  await seedServices(prisma);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
