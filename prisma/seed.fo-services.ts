import {
  PrismaClient,
  ServiceCategory,
  CertificateType,
} from "@prisma/client";

import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import "dotenv/config";

// ───────────────────────────────────────────────────────────────────────────
// Field-officer-only services seeding (standalone, run once on production)
//
// Source: the LGA internal revenue catalogue in the Developer Requirements
// document, sections 3.1 to 3.5 (Licences, Fees, Fines, Sales, Earnings).
//
//   npm run seed:fo-services
//
// Production has no ts-node in its install, so run it the same way the
// wards were seeded:
//
//   npx --yes -p ts-node -p typescript ts-node prisma/seed.fo-services.ts
//
// Every entry is an internal, field-officer-only service: foOnly is true,
// there is NO fee config (the officer records the amount per collection),
// and the revenue head carries the catalogue head code from the document.
//
// Entries the source images show crossed out are NOT seeded, and neither is
// the duplicated Lock Up Shop, until the Local Government confirms the
// final list: Lock Up Shop (both places), Marriage & Divorce Fee, Burial
// Fee, Indigeneous Registration Fees, Certificate of Indigeneship, and
// Sales of Stones / Scrap / Unserviceable Items. Entertainment Levy is
// also held back: its classification and code are still pending.
//
// Codes carry the fo_ prefix so a seeded row can never collide with, or
// overwrite, a public catalogue service (Tenement Rate, Street Naming).
// Rows upsert by code, so re-running the file is harmless.
// ───────────────────────────────────────────────────────────────────────────

interface SeedFoService {
  code: string;
  name: string;
  category: ServiceCategory;
  revenueHead: string;
}

const LIC = ServiceCategory.LICENCES_AND_PERMITS;
const OTH = ServiceCategory.OTHERS;

const FO_SERVICES: SeedFoService[] = [
  // 3.1 Licences General — revenue head 120201 (24 of 26; Lock Up Shop held)
  { code: "fo_radio_television", name: "Radio / Television", category: LIC, revenueHead: "120201" },
  { code: "fo_registration_voluntary_organisations", name: "Registration of Voluntary Organisations", category: LIC, revenueHead: "120201" },
  { code: "fo_bake_eating_house", name: "Bake & Eating House", category: LIC, revenueHead: "120201" },
  { code: "fo_bicycle_licences_hire_permit", name: "Bicycle Licences & Hire Permit", category: LIC, revenueHead: "120201" },
  { code: "fo_brickmaking_tc_licences", name: "Brickmaking & T.C. Licences", category: LIC, revenueHead: "120201" },
  { code: "fo_cart_licences", name: "Cart Licences", category: LIC, revenueHead: "120201" },
  { code: "fo_dane_guns_licences", name: "Dane Guns Licences", category: LIC, revenueHead: "120201" },
  { code: "fo_cattle_dealer_licences", name: "Cattle Dealer Licences", category: LIC, revenueHead: "120201" },
  { code: "fo_dried_fish_meat_licences", name: "Dried Fish and Meat Licences", category: LIC, revenueHead: "120201" },
  { code: "fo_pet_dog_licences", name: "Pet Dog Licences", category: LIC, revenueHead: "120201" },
  { code: "fo_hawkers_permit", name: "Hawkers Permit", category: LIC, revenueHead: "120201" },
  { code: "fo_produce_buying_licences", name: "Produce Buying Licences", category: LIC, revenueHead: "120201" },
  { code: "fo_animal_health_certificate", name: "Animal Health Certificate", category: LIC, revenueHead: "120201" },
  { code: "fo_abattoirs_slaughters_fees", name: "Abattoirs / Slaughters Fees", category: LIC, revenueHead: "120201" },
  { code: "fo_hiring_services", name: "Hiring Services", category: LIC, revenueHead: "120201" },
  { code: "fo_borehole_drilling_licences", name: "Borehole Drilling Licences", category: LIC, revenueHead: "120201" },
  { code: "fo_liquor_licence", name: "Liquor Licence", category: LIC, revenueHead: "120201" },
  { code: "fo_private_school", name: "Private School", category: LIC, revenueHead: "120201" },
  { code: "fo_trade_permit", name: "Trade Permit", category: LIC, revenueHead: "120201" },
  { code: "fo_hackney_permit_motorcycle", name: "Hackney Permit / Motorcycle", category: LIC, revenueHead: "120201" },
  { code: "fo_kiosks_mast_licences", name: "Kiosks / Mast Licences", category: LIC, revenueHead: "120201" },
  { code: "fo_feedmiller_vendor_licence", name: "Feedmiller & Vendor Licence", category: LIC, revenueHead: "120201" },
  { code: "fo_sawmill_licences", name: "Sawmill Licences", category: LIC, revenueHead: "120201" },
  { code: "fo_cold_room", name: "Cold Room", category: LIC, revenueHead: "120201" },

  // 3.2 Fees General — revenue head 12020400 (18 of 22; 4 crossed out held)
  { code: "fo_trade_union_fees", name: "Trade Union Fees", category: OTH, revenueHead: "12020400" },
  { code: "fo_contractor_registration_fees", name: "Contractor Registration Fees", category: OTH, revenueHead: "12020400" },
  { code: "fo_attestation_bachelor_spinsterhood", name: "Attestation of Bachelor / Spinsterhood", category: OTH, revenueHead: "12020400" },
  { code: "fo_tender_fees", name: "Tender Fees", category: OTH, revenueHead: "12020400" },
  { code: "fo_billboard_advertisement_fees", name: "Billboard Advertisement Fees", category: OTH, revenueHead: "12020400" },
  { code: "fo_association_fees", name: "Association Fees", category: OTH, revenueHead: "12020400" },
  { code: "fo_development_levies", name: "Development Levies", category: OTH, revenueHead: "12020400" },
  { code: "fo_business_trade_opening_fees", name: "Business and Trade Opening Fees", category: OTH, revenueHead: "12020400" },
  { code: "fo_parking_fee_toll_gate", name: "Parking Fee / Toll Gate", category: OTH, revenueHead: "12020400" },
  { code: "fo_sewage_management_fees", name: "Sewage Management Fees", category: OTH, revenueHead: "12020400" },
  { code: "fo_other_contract_fees", name: "Other Contract Fees", category: OTH, revenueHead: "12020400" },
  { code: "fo_tenement_rate", name: "Tenement Rate", category: OTH, revenueHead: "12020400" },
  { code: "fo_motor_parks_fees", name: "Motor Parks Fees", category: OTH, revenueHead: "12020400" },
  { code: "fo_squatters_fee", name: "Squatters Fee", category: OTH, revenueHead: "12020400" },
  { code: "fo_street_naming_fees", name: "Street Naming Fees", category: OTH, revenueHead: "12020400" },
  { code: "fo_identification_oath_fees", name: "Identification and Oath Fees", category: OTH, revenueHead: "12020400" },
  { code: "fo_stalls_lockup_shop_shopping", name: "Stalls, Lock-Up-Shop & Shopping", category: OTH, revenueHead: "12020400" },
  { code: "fo_motorcycle_tricycle_fees", name: "Motorcycle & Tricycle Fees", category: OTH, revenueHead: "12020400" },

  // 3.3 Fines General — revenue head 120207 (2 of 2)
  { code: "fo_penal_fees_private_toilet", name: "Penal Fees / Private Toilet", category: OTH, revenueHead: "120207" },
  { code: "fo_other_fines_social_welfare", name: "Other Fines (Social Welfare Charges)", category: OTH, revenueHead: "120207" },

  // 3.4 Sales General — revenue head 12020600 (8 of 9; 1 crossed out held)
  { code: "fo_sales_id_cards", name: "Sales of I.D. Cards", category: OTH, revenueHead: "12020600" },
  { code: "fo_sales_improved_seeds_chemicals", name: "Sales of Improved Seeds and Chemicals", category: OTH, revenueHead: "12020600" },
  { code: "fo_proceed_sales_vehicle", name: "Proceed from Sales of Vehicle", category: OTH, revenueHead: "12020600" },
  { code: "fo_proceed_sales_drugs_medication", name: "Proceed from Sales of Drugs & Medication", category: OTH, revenueHead: "12020600" },
  { code: "fo_sales_uniforms", name: "Sales of Uniforms", category: OTH, revenueHead: "12020600" },
  { code: "fo_sales_poultry_arable_animals", name: "Sales of Poultry and Arable Animals", category: OTH, revenueHead: "12020600" },
  { code: "fo_sales_fertilizers", name: "Sales of Fertilizers", category: OTH, revenueHead: "12020600" },
  { code: "fo_other_sales", name: "Other Sales", category: OTH, revenueHead: "12020600" },

  // 3.5 Earning General — revenue head 12020700 (8 of 8)
  { code: "fo_earning_laboratory_services", name: "Earning from Laboratory Services", category: OTH, revenueHead: "12020700" },
  { code: "fo_earning_hired_plant_equipment", name: "Earning from Hired Plant & Equipment", category: OTH, revenueHead: "12020700" },
  { code: "fo_earning_use_of_govt", name: "Earning from the Use of Govt.", category: OTH, revenueHead: "12020700" },
  { code: "fo_earning_use_of_govt_halls", name: "Earning from the Use of Govt. Halls", category: OTH, revenueHead: "12020700" },
  { code: "fo_earning_medical_services_delivery", name: "Earning from Medical Services, Delivery & Others", category: OTH, revenueHead: "12020700" },
  { code: "fo_earning_agricultural_services", name: "Earning from the Agricultural Services", category: OTH, revenueHead: "12020700" },
  { code: "fo_earning_commercial_activities", name: "Earning from Commercial Activities", category: OTH, revenueHead: "12020700" },
  { code: "fo_earning_plantation_scheme", name: "Earning from Plantation Scheme", category: OTH, revenueHead: "12020700" },
];

export async function seedFoServices(prisma: PrismaClient) {
  console.log(` Seeding ${FO_SERVICES.length} field-officer-only services...`);
  for (const s of FO_SERVICES) {
    const data = {
      name: s.name,
      category: s.category,
      revenueHead: s.revenueHead,
      description: `${s.name}, collected by authorised field officers on behalf of the Local Government.`,
      requirements: [] as string[],
      estimatedDays: 1,
      certificateType: CertificateType.NONE,
      supportsRenewal: false,
      isActive: true,
      foOnly: true,
    };
    await prisma.service.upsert({
      where: { code: s.code },
      update: data,
      create: { code: s.code, ...data },
    });
    console.log(`✅ ${s.code} → ${s.name}`);
  }
}

if (require.main === module) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  seedFoServices(prisma)
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
      await pool.end();
    });
}
