import { prisma } from "../../utils/prisma";

/** Confirmed revenue only; a payment can appear through several invoice relations. */
export function sumUniqueConfirmedPayments(
  invoices: Array<{ payments: Array<{ id: string; amount: unknown }> }>,
) {
  const payments = new Map<string, number>();
  for (const invoice of invoices) {
    for (const payment of invoice.payments) {
      payments.set(payment.id, Number(payment.amount));
    }
  }
  return [...payments.values()].reduce((sum, amount) => sum + amount, 0);
}

export async function fetchFieldOfficerMetrics(creatorId?: string) {
  const officers = await prisma.user.findMany({
    where: { role: "field_officer", ...(creatorId ? { createdById: creatorId } : {}) },
    select: {
      id: true, firstName: true, lastName: true, email: true, phone: true,
      role: true, isActive: true, suspendedAt: true, createdAt: true,
      ward: { select: { id: true, name: true } },
      createdBy: { select: { id: true, firstName: true, lastName: true } },
      createdUsers: {
        where: { role: { in: ["citizen", "business_owner"] } },
        select: { id: true },
      },
      createdApplications: {
        select: {
          service: { select: { name: true } },
          invoice: { select: { payments: {
            where: { status: "confirmed" }, select: { id: true, amount: true },
          } } },
        },
      },
      invoicesCreated: { select: { payments: {
        where: { status: "confirmed" }, select: { id: true, amount: true },
      } } },
      invoicesAssignedTo: { select: { payments: {
        where: { status: "confirmed" }, select: { id: true, amount: true },
      } } },
    },
    orderBy: { createdAt: "desc" },
  });
  const mapped = officers.map((officer) => ({
    id: officer.id,
    name: `${officer.firstName} ${officer.lastName}`.trim(),
    email: officer.email, phone: officer.phone, role: officer.role,
    ward: officer.ward, createdAt: officer.createdAt,
    status: officer.suspendedAt ? "suspended" : officer.isActive ? "active" : "deactivated",
    createdBy: officer.createdBy ? {
      id: officer.createdBy.id,
      name: `${officer.createdBy.firstName} ${officer.createdBy.lastName}`.trim(),
    } : null,
    usersRegistered: officer.createdUsers.length,
    applicationsCreated: officer.createdApplications.length,
    services: [...new Set(officer.createdApplications.map((app) => app.service.name))],
    totalCollected: sumUniqueConfirmedPayments([
      ...officer.invoicesCreated, ...officer.invoicesAssignedTo,
      ...officer.createdApplications.flatMap((app) => app.invoice ? [app.invoice] : []),
    ]),
  }));
  return {
    stats: {
      totalOfficers: mapped.length,
      active: mapped.filter((o) => o.status === "active").length,
      suspended: mapped.filter((o) => o.status === "suspended").length,
      deactivated: mapped.filter((o) => o.status === "deactivated").length,
      usersRegistered: mapped.reduce((sum, o) => sum + o.usersRegistered, 0),
      totalCollected: mapped.reduce((sum, o) => sum + o.totalCollected, 0),
    },
    officers: mapped,
  };
}
