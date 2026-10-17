import {
  PrismaClient,
  ServiceCategory,
  CertificateType,
  FeeStatus,
} from "@prisma/client";

import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

// ───────────────────────────────────────────────────────────────────────────
// LGA service catalog seeding
//
// The catalog lives in `prisma/data/<LGA_ID>.services.json` — onboarding a
// new LGA means dropping in a data file and setting the LGA_* env vars in
// `.env` (see LGA_CLONE_AND_ONBOARDING_GUIDE). No code edits required.
//
// Descriptions may use the `{lgaName}` / `{lgaFullName}` tokens; they are
// interpolated with the active LGA values below. This file reads LGA_*
// directly from the environment (instead of src/config/lga.config.ts) so it
// stays independent of the backend tsconfig, which excludes `prisma/`.
// ───────────────────────────────────────────────────────────────────────────

const lgaId = process.env.LGA_ID?.trim() || "odeda";
const lgaName = process.env.LGA_NAME?.trim() || lgaId;
const lgaFullName =
  process.env.LGA_FULL_NAME?.trim() || `${lgaName} Local Government`;

interface SeedService {
  code: string;
  certificateType: string;
  name: string;
  description: string;
  category: string;
  revenueHead: string;
  requirements: string[];
  estimatedDays: number;
  fee: number;
}

function loadServices(): SeedService[] {
  const filePath = join(__dirname, "data", `${lgaId}.services.json`);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(
      `[seed] Missing services file for LGA "${lgaId}": ${filePath}. ` +
        `Create prisma/data/${lgaId}.services.json (copy the example services data file for the format).`,
    );
  }
  const parsed = JSON.parse(raw) as SeedService[];
  const interpolate = (text: string) =>
    text
      .replace(/\{lgaName\}/g, lgaName)
      .replace(/\{lgaFullName\}/g, lgaFullName);
  return parsed.map((s) => ({ ...s, description: interpolate(s.description) }));
}

async function main() {
  const services = loadServices();

  console.log(` Seeding services for ${lgaName} (${lgaId})...`);

  for (const s of services) {
    const supportsRenewal = [
      "liquor_licence",
      "viewing_centre_licence",
      "kiosk_licence",
      "quarry_permit",
    ].includes(s.code);

    // ---------------------------------------------------------
    // 1. Create/update service
    // ---------------------------------------------------------
    const service = await prisma.service.upsert({
      where: {
        code: s.code,
      },
      update: {
        name: s.name,
        category: s.category as ServiceCategory,
        revenueHead: s.revenueHead,
        requirements: s.requirements,
        estimatedDays: s.estimatedDays,
        certificateType: s.certificateType as CertificateType,
        supportsRenewal,
        isActive: true,
        description: s.description,
      },
      create: {
        code: s.code,
        name: s.name,
        description: s.description,
        certificateType: s.certificateType as CertificateType,
        category: s.category as ServiceCategory,
        revenueHead: s.revenueHead,
        requirements: s.requirements,
        estimatedDays: s.estimatedDays,
        supportsRenewal,
        isActive: true,
      },
    });

    // ---------------------------------------------------------
    // 2. Create/update the service fee configuration
    // ---------------------------------------------------------
    await prisma.serviceFeeConfig.upsert({
      where: {
        serviceId: service.id,
      },
      update: {
        amount: s.fee,
        status: FeeStatus.ACTIVE,
      },
      create: {
        serviceId: service.id,
        amount: s.fee,
        status: FeeStatus.ACTIVE,
      },
    });

    console.log(
      `✅ ${service.name} → ₦${s.fee.toLocaleString()} (${FeeStatus.ACTIVE})`,
    );
  }

  console.log(
    `✅ ${lgaName} (${lgaId}) services and service fees seeded successfully`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
