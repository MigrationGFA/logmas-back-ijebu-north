# LOGMAS Backend — Prisma Schema Structure
## Updated Prisma Database Schema Specification (`schema.md`)

This document defines the production-ready Prisma schema designed for the unified **Local Government Area (LGA) LOGMAS Portal**.

---

### Key Schema Architecture Improvements
1. **Unified Services & Applications Framework**: Replaced hardcoded single-purpose models (`StateOfOriginApplication`, `LevyConfig`, `PermitConfig`) with flexible `Service`, `FeeSchedule`, and `ServiceApplication` models capable of powering the LGA's statutory services seamlessly.
2. **Comprehensive 13-Step Citizen Workflow Support**: Supports draft auto-save, statutory certification & non-refundable declaration tracking, field officer inspection reports, Treasury tariff assessment, dedicated virtual payment accounts, LGA Admin approval loops, and automated certificate generation.
3. **Role-Based Workflows**: Tailored for **Citizens**, **Business Owners**, **Field Officers**, **Treasurers**, **LGA Admins**, **Ward Councillors**, **Auditors**, and **Contractors**.

---

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["driverAdapters"]
}

// ============================================================
// ENUMS
// ============================================================

enum Role {
  super_admin
  lga_admin
  chairman
  treasurer
  auditor
  ward_councillor
  contractor
  agent
  field_officer
  business_owner
  citizen
}

enum ServiceCategory {
  CERTIFICATE
  RATES_AND_LEVIES
  LICENCES_AND_PERMITS
  URBAN_DEVELOPMENT
}

enum FeeType {
  fixed
  variable
  tiered
}

enum ApplicationStatus {
  draft
  submitted
  under_review
  inspection_required
  inspection_completed
  awaiting_information
  awaiting_assessment
  invoice_generated
  awaiting_payment
  payment_confirmed
  pending_approval
  approved
  returned_for_correction
  rejected
  certificate_generated
  completed
  expired
  revoked
}

enum InvoiceStatus {
  draft
  sent
  paid
  overdue
  cancelled
  partially_paid
}

enum PaymentMethod {
  online_gateway
  bank_transfer
  virtual_account
  pos
  cash
}

enum PaymentStatus {
  pending
  confirmed
  failed
  reversed
}

enum ComplaintStatus {
  open
  assigned
  in_progress
  resolved
  closed
}

enum NotificationChannel {
  sms
  email
  whatsapp
  in_app
}

enum NotificationStatus {
  pending
  sent
  failed
}

enum AuditAction {
  login
  logout
  login_failed
  declaration_accepted
  application_created
  application_submitted
  field_inspection_logged
  treasury_assessed
  invoice_created
  invoice_adjusted
  invoice_cancelled
  payment_confirmed
  payment_reversed
  receipt_generated
  approval_granted
  correction_requested
  application_rejected
  certificate_issued
  certificate_revoked
  user_created
  user_updated
  user_suspended
}

enum ViolationSeverity {
  minor
  moderate
  critical
}

enum ViolationStatus {
  open
  under_review
  resolved
  dismissed
}

// ============================================================
// USERS & IDENTITY
// ============================================================

model User {
  id           String   @id @default(uuid())
  email        String   @unique
  phone        String?  @unique
  password     String
  firstName    String
  lastName     String
  role         Role     @default(citizen)
  tokenVersion Int      @default(0)

  // Profile Information
  avatarUrl       String?
  dateOfBirth     DateTime?
  gender          String?
  address         String?
  town            String?
  occupation      String?
  idType          String?   // NIN, Voters Card, Drivers Licence, CAC
  nin             String?   @unique
  cacNumber       String?   @unique
  businessName    String?
  businessType    String?
  taxIdNumber     String?

  // Account Status & Security
  isActive              Boolean   @default(true)
  suspendedAt           DateTime?
  suspendedById         String?
  suspendedBy           User?     @relation("UserSuspender", fields: [suspendedById], references: [id])
  suspendedUsers        User[]    @relation("UserSuspender")
  suspensionReason      String?
  passwordResetRequired Boolean   @default(false)
  lastLoginAt           DateTime?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  deletedAt             DateTime?

  // Notifications preferences
  notifyByEmail Boolean @default(true)
  notifyBySms   Boolean @default(true)
  notifyByInApp Boolean @default(true)

  // Ward & Political Governance
  wardId String?
  ward   Ward?   @relation("UserWard", fields: [wardId], references: [id])

  assignedWardId String? @unique
  assignedWard   Ward?   @relation("WardCouncillor", fields: [assignedWardId], references: [id])

  // Contractor & Agent Hierarchy
  contractorId            String?
  contractor              User?   @relation("ContractorAgents", fields: [contractorId], references: [id])
  agents                  User[]  @relation("ContractorAgents")
  commissionRate          Float?  @default(0.0)
  assignedContractorWards Ward[]  @relation("ContractorWards")

  agentId         String?
  agent           User?   @relation("AgentOfficers", fields: [agentId], references: [id])
  managedOfficers User[]  @relation("AgentOfficers")

  // Walk-in Registration
  isWalkIn             Boolean @default(false)
  walkInRegisteredById String?
  walkInRegisteredBy   User?   @relation("WalkInCreator", fields: [walkInRegisteredById], references: [id])
  walkInUsers          User[]  @relation("WalkInCreator")

  // Relational Collections
  serviceApplications        ServiceApplication[]  @relation("ApplicantApplications")
  inspectionsConducted       FieldInspection[]     @relation("InspectorConducted")
  treasuryAssessments        TreasuryAssessment[]  @relation("TreasurerAssessed")
  approvalsGranted           ApplicationApproval[] @relation("ApprovedByAdmin")
  invoicesCreated            Invoice[]             @relation("InvoiceCreatedBy")
  invoicesAssigned           Invoice[]             @relation("InvoiceAssignedOfficer")
  payments                   Payment[]
  receiptsIssued             Receipt[]             @relation("ReceiptIssuedBy")
  certificatesIssued         Certificate[]         @relation("CertificateIssuedBy")
  complaintsRaised           Complaint[]           @relation("ComplaintRaisedBy")
  complaintsAssigned         Complaint[]           @relation("ComplaintAssignedTo")
  violationsLogged           Violation[]           @relation("ViolationLoggedBy")
  createdUsers               User[]                @relation("UserCreator")
  createdById                String?
  createdBy                  User?                 @relation("UserCreator", fields: [createdById], references: [id])
  notifications              Notification[]
  auditLogs                  AuditLog[]

  @@map("users")
}

// ============================================================
// GEOGRAPHY
// ============================================================

model Ward {
  id          String    @id @default(uuid())
  name        String    @unique
  code        String    @unique // e.g. "WARD_01"
  description String?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?

  users       User[]               @relation("UserWard")
  councillor  User?                @relation("WardCouncillor")
  contractors User[]               @relation("ContractorWards")
  services    ServiceApplication[]
  complaints  Complaint[]
  violations  Violation[]

  @@map("wards")
}

// ============================================================
// UNIFIED SERVICES & FEE SCHEDULES
// ============================================================

model Service {
  id              String          @id @default(uuid()) // e.g. "certificate_of_origin", "tenement_rate"
  name            String
  category        ServiceCategory
  revenueHead     String          // e.g. "1001 - Statutory Certificate Fees"
  description     String
  requirements    String[]        // Array of required supporting document names
  estimatedDays   Int             @default(3)
  defaultFee      Decimal         @db.Decimal(12, 2)
  feeType         FeeType         @default(fixed)
  feeDescription  String
  supportsRenewal Boolean         @default(false)
  isActive        Boolean         @default(true)
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt

  feeSchedules ServiceFeeSchedule[]
  applications ServiceApplication[]

  @@map("services")
}

model ServiceFeeSchedule {
  id              String   @id @default(uuid())
  serviceId       String
  service         Service  @relation(fields: [serviceId], references: [id])
  name            String   // e.g. "Commercial Property Grade A Tariff"
  feeType         FeeType  @default(fixed)
  baseFee         Decimal  @db.Decimal(12, 2)
  revenueHead     String
  calculationRule String?  // Assessment formula note or rule expression
  latePenaltyRate Decimal? @default(10) @db.Decimal(5, 2) // percentage
  billingCycle    String?  // One-time vs Annual Renewal
  isActive        Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@map("service_fee_schedules")
}

// ============================================================
// GENERAL SERVICE APPLICATION WORKFLOW
// ============================================================

model ServiceApplication {
  id            String            @id @default(uuid())
  applicationNo String            @unique @default(cuid()) // e.g. "INE-APP-2026-001"
  status        ApplicationStatus @default(draft)

  serviceId String
  service   Service @relation(fields: [serviceId], references: [id])

  // Applicant details snapshot
  applicantId String
  applicant   User   @relation("ApplicantApplications", fields: [applicantId], references: [id])
  fullName    String
  phone       String
  email       String?
  address     String
  wardId      String?
  ward        Ward?   @relation(fields: [wardId], references: [id])
  nin         String?
  cacNumber   String?

  // Flexible Application Data JSON (Supports form payloads for all 12 services)
  formData Json

  // Step 5: Certification & Legal Declaration Audit
  declarationAcceptedAt DateTime?
  declarationIpAddress  String?
  declarationVersion    String?   @default("v1.0-lga-2026")

  // Workflow Inspection, Assessment & Approval Audit Relations
  inspectionReport   FieldInspection?
  treasuryAssessment TreasuryAssessment?
  approvalRecord     ApplicationApproval?

  // Financial & Output Artifacts
  invoiceId   String?      @unique
  invoice     Invoice?     @relation(fields: [invoiceId], references: [id])
  certificate Certificate?

  rejectionReason String?
  correctionNotes String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("service_applications")
}

// ============================================================
// FIELD INSPECTION REPORT
// ============================================================

model FieldInspection {
  id                  String             @id @default(uuid())
  applicationId       String             @unique
  application         ServiceApplication @relation(fields: [applicationId], references: [id])
  inspectorId         String
  inspector           User               @relation("InspectorConducted", fields: [inspectorId], references: [id])
  findings            String
  recommendedCategory String?
  recommendedFee      Decimal?           @db.Decimal(12, 2)
  sitePhotos          String[]
  completedAt         DateTime           @default(now())

  @@map("field_inspections")
}

// ============================================================
// TREASURY ASSESSMENT & TARIFF APPROVAL
// ============================================================

model TreasuryAssessment {
  id            String             @id @default(uuid())
  applicationId String             @unique
  application   ServiceApplication @relation(fields: [applicationId], references: [id])
  assessedById  String
  assessedBy    User               @relation("TreasurerAssessed", fields: [assessedById], references: [id])
  approvedFee   Decimal            @db.Decimal(12, 2)
  revenueHead   String
  treasuryNotes String?
  assessedAt    DateTime           @default(now())

  @@map("treasury_assessments")
}

// ============================================================
// LGA ADMIN APPROVAL LOOP
// ============================================================

model ApplicationApproval {
  id            String             @id @default(uuid())
  applicationId String             @unique
  application   ServiceApplication @relation(fields: [applicationId], references: [id])
  approvedById  String
  approvedBy    User               @relation("ApprovedByAdmin", fields: [approvedById], references: [id])
  decision      String             // "approved", "returned_for_correction", "rejected", "pending"
  notes         String?
  decidedAt     DateTime           @default(now())

  @@map("application_approvals")
}

// ============================================================
// INVOICES, DEDICATED ACCOUNTS, PAYMENTS & RECEIPTS
// ============================================================

model Invoice {
  id            String        @id @default(uuid())
  invoiceNumber String        @unique @default(cuid()) // e.g. "<LGA_SHORT_CODE>/INV/2026/00101"
  status        InvoiceStatus @default(draft)
  revenueHead   String
  description   String?

  amountPayable Decimal @db.Decimal(12, 2)
  amountPaid    Decimal @default(0) @db.Decimal(12, 2)
  balanceDue    Decimal @db.Decimal(12, 2)

  dueDate DateTime?
  paidAt  DateTime?

  // Step 10: Dedicated / Virtual Bank Account Details
  virtualAccountNo   String?
  virtualAccountBank String? @default("Zenith Bank / LGA Treasury")
  virtualAccountRef  String? @unique
  qrToken            String  @unique @default(cuid())
  verificationCode   String  @unique @default(cuid())

  // Creator & Assignee Accountability
  createdById       String
  createdBy         User   @relation("InvoiceCreatedBy", fields: [createdById], references: [id])
  assignedOfficerId String?
  assignedOfficer   User?  @relation("InvoiceAssignedOfficer", fields: [assignedOfficerId], references: [id])

  application ServiceApplication?
  payments    Payment[]
  receipt     Receipt?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("invoices")
}

model Payment {
  id         String        @id @default(uuid())
  amount     Decimal       @db.Decimal(12, 2)
  method     PaymentMethod @default(virtual_account)
  status     PaymentStatus @default(pending)
  reference  String        @unique
  gatewayRef String?
  narration  String?

  confirmedAt   DateTime?
  invoiceId     String
  invoice       Invoice   @relation(fields: [invoiceId], references: [id])
  paidById      String?
  paidBy        User?     @relation(fields: [paidById], references: [id])

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("payments")
}

model Receipt {
  id               String   @id @default(uuid())
  receiptNumber    String   @unique // e.g. "<LGA_SHORT_CODE>/RCP/2026/00101"
  verificationCode String   @unique
  qrToken          String   @unique
  amountPaid       Decimal  @db.Decimal(12, 2)
  pdfUrl           String?
  issuedAt         DateTime @default(now())

  invoiceId   String  @unique
  invoice     Invoice @relation(fields: [invoiceId], references: [id])
  issuedById  String
  issuedBy    User    @relation("ReceiptIssuedBy", fields: [issuedById], references: [id])

  @@map("receipts")
}

// ============================================================
// CERTIFICATE / LICENCE GENERATION
// ============================================================

model Certificate {
  id                String             @id @default(uuid())
  certificateNumber String             @unique // e.g. "<LGA_SHORT_CODE>/CERT/2026/00101"
  verificationCode  String             @unique
  qrToken           String             @unique
  issuedAt          DateTime           @default(now())
  expiresAt         DateTime?
  pdfUrl            String?

  applicationId String             @unique
  application   ServiceApplication @relation(fields: [applicationId], references: [id])

  issuedById String?
  issuedBy   User?   @relation("CertificateIssuedBy", fields: [issuedById], references: [id])

  @@map("certificates")
}

// ============================================================
// COMPLAINTS & CIVIC ISSUES
// ============================================================

model Complaint {
  id           String          @id @default(uuid())
  ticketNumber String          @unique @default(cuid())
  title        String
  description  String
  category     String
  status       ComplaintStatus @default(open)

  raisedById String
  raisedBy   User   @relation("ComplaintRaisedBy", fields: [raisedById], references: [id])

  wardId String?
  ward   Ward?   @relation(fields: [wardId], references: [id])

  assignedToId String?
  assignedTo   User?   @relation("ComplaintAssignedTo", fields: [assignedToId], references: [id])

  assignedAt     DateTime?
  resolvedAt     DateTime?
  resolutionNote String?

  responses ComplaintResponse[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("complaints")
}

model ComplaintResponse {
  id          String   @id @default(uuid())
  message     String
  responderId String
  createdAt   DateTime @default(now())

  complaintId String
  complaint   Complaint @relation(fields: [complaintId], references: [id])

  @@map("complaint_responses")
}

// ============================================================
// NOTIFICATIONS
// ============================================================

model Notification {
  id String @id @default(uuid())

  userId String
  user   User   @relation(fields: [userId], references: [id])

  templateKey String
  title       String?
  message     String

  isRead Boolean   @default(false)
  readAt DateTime?

  smsStatus     NotificationStatus?
  smsSentAt     DateTime?
  smsFailReason String?

  emailStatus     NotificationStatus?
  emailSentAt     DateTime?
  emailFailReason String?

  createdAt DateTime @default(now())

  @@map("notifications")
}

// ============================================================
// ENFORCEMENT & VIOLATIONS
// ============================================================

model Violation {
  id           String            @id @default(uuid())
  businessName String?
  address      String?
  wardId       String
  ward         Ward              @relation(fields: [wardId], references: [id])
  description  String
  severity     ViolationSeverity @default(minor)
  status       ViolationStatus   @default(open)

  loggedById   String
  loggedBy     User              @relation("ViolationLoggedBy", fields: [loggedById], references: [id])

  resolvedAt   DateTime?
  resolvedNote String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("violations")
}

// ============================================================
// SYSTEM AUDIT LOGS
// ============================================================

model AuditLog {
  id        String      @id @default(uuid())
  action    AuditAction
  entity    String?
  entityId  String?
  details   Json?
  ipAddress String?
  userAgent String?
  createdAt DateTime    @default(now())

  userId String?
  user   User?   @relation(fields: [userId], references: [id])

  @@map("audit_logs")
}
```

---

### Migration Summary for VS Code / Backend Setup
1. **Remove Old Single-Purpose Tables**: Drop legacy tables `state_of_origin_applications`, `levy_configs`, and `permit_configs`.
2. **Apply New Prisma Migration**: Run `npx prisma migrate dev --name init_lga_services_schema`.
3. **Seed the Initial LGA Services**: Execute seed script to populate the `Service` and `ServiceFeeSchedule` tables with the core statutory LGA services.
