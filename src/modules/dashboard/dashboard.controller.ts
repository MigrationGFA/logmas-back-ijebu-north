import {
  Role,
  InvoiceStatus,
  ApplicationStatus,
  ComplaintStatus,
  User,
  PaymentStatus,
  PaymentMethod,
  ServiceCategory,
} from "@prisma/client";
import { prisma } from "../../utils/prisma";

export const fetchMetricsByRole = async (
  role: Role,
  userId: string,
  user: User,
) => {
  switch (role) {
    case Role.citizen: {
      const [applications, complaints, invoices] = await Promise.all([
        prisma.application.findMany({
          where: { applicantId: userId },
          include: {
            service: { select: { code: true, name: true } },
            applicationDocuments: { select: { id: true } },
            invoice: { select: { amount: true, paymentStatus: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
        prisma.complaint.count({
          where: {
            raisedById: userId,
            status: { not: ComplaintStatus.closed },
          },
        }),
        prisma.invoice.findMany({
          where: { application: { applicantId: userId } },
          select: { id: true, amount: true, paymentStatus: true },
        }),
      ]);

      const statusCounts = applications.reduce(
        (acc: Record<string, number>, a) => {
          acc[a.status] = (acc[a.status] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      const pendingPaymentAmount = invoices.reduce((sum, inv) => {
        return (
          sum +
          (inv.paymentStatus === PaymentStatus.confirmed
            ? 0
            : Number(inv.amount ?? 0))
        );
      }, 0);

      return {
        metrics: {
          pendingPayments: pendingPaymentAmount,
          approvedApplications: statusCounts[ApplicationStatus.approved] ?? 0,
          awaitingForm: statusCounts[ApplicationStatus.awaiting_form] ?? 0,
          submitted: statusCounts[ApplicationStatus.submitted] ?? 0,
          openComplaints: complaints,
        },
        recentApplications: applications.map((a) => ({
          id: a.id,
          applicationNumber: a.applicationNumber,
          service: a.service?.name ?? a.service?.code,
          status: a.status,
          feeAmount: Number(a.feeAmount ?? 0),
          createdAt: a.createdAt,
        })),
      };
    }

    case Role.business_owner: {
      const [applications, invoices, recentApplications] = await Promise.all([
        prisma.application.count({
          where: { OR: [{ applicantId: userId }, { createdById: userId }] },
        }),
        prisma.invoice.findMany({
          where: {
            application: {
              OR: [{ applicantId: userId }, { createdById: userId }],
            },
          },
          select: { id: true, amount: true, paymentStatus: true },
        }),
        prisma.application.findMany({
          where: { OR: [{ applicantId: userId }, { createdById: userId }] },
          include: {
            service: { select: { name: true } },
            invoice: { select: { amount: true, paymentStatus: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 5,
        }),
      ]);

      const totalPaid = invoices.reduce(
        (s, inv) =>
          s +
          (inv.paymentStatus === PaymentStatus.confirmed
            ? Number(inv.amount ?? 0)
            : 0),
        0,
      );
      const outstanding = invoices.reduce(
        (s, inv) =>
          s +
          (inv.paymentStatus === PaymentStatus.confirmed
            ? 0
            : Number(inv.amount ?? 0)),
        0,
      );

      return {
        metrics: {
          totalApplications: applications,
          totalPaid,
          outstanding,
        },
        recentApplications: recentApplications.map((a) => ({
          id: a.id,
          applicationNumber: a.applicationNumber,
          service: a.service?.name,
          status: a.status,
          amount: Number(a.invoice?.amount ?? a.feeAmount ?? 0),
        })),
      };
    }

    case Role.treasurer: {
      // Treasurer: Aggregate confirmed payments and revenue metrics
      const [confirmedPayments, pendingInvoices, activeOfficers] =
        await Promise.all([
          prisma.payment.findMany({
            where: { status: PaymentStatus.confirmed },
            include: {
              invoice: {
                include: {
                  application: {
                    include: {
                      service: { select: { name: true, category: true } },
                    },
                  },
                },
              },
            },
          }),
          prisma.invoice.findMany({
            where: {
              paymentStatus: {
                notIn: [PaymentStatus.confirmed],
              },
            },
            select: {
              id: true,
              amount: true,
              paymentStatus: true,
            },
          }),
          prisma.user.count({
            where: {
              role: Role.field_officer,
              isActive: true,
            },
          }),
        ]);

      // Calculate metrics
      const totalRevenue = confirmedPayments.reduce(
        (s, p) => s + Number(p.amount ?? 0),
        0,
      );

      const pendingAmount = pendingInvoices.reduce(
        (s, inv) => s + Number(inv.amount ?? 0),
        0,
      );

      // Monthly revenue by confirmed payments
      const monthlyMap: Record<string, number> = {};
      confirmedPayments.forEach((p) => {
        const m = new Date(p.createdAt).getMonth();
        const key = String(m + 1);
        monthlyMap[key] = (monthlyMap[key] || 0) + Number(p.amount ?? 0);
      });

      const revenueTrend = Array.from({ length: 12 }).map((_, i) => ({
        month: i + 1,
        amount: monthlyMap[String(i + 1)] ?? 0,
      }));

      // Service breakdown
      const serviceMap: Record<string, number> = {};
      confirmedPayments.forEach((p) => {
        const svc = p.invoice?.application?.service?.name ?? "Other";
        serviceMap[svc] = (serviceMap[svc] || 0) + Number(p.amount ?? 0);
      });

      const serviceBreakdown = Object.entries(serviceMap).map(
        ([service, amount]) => ({ service, amount }),
      );

      // Category revenue breakdown
      const categoryMap: Record<string, number> = {};
      confirmedPayments.forEach((p) => {
        const cat =
          p.invoice?.application?.service?.category ??
          ServiceCategory.CERTIFICATE;
        categoryMap[cat] = (categoryMap[cat] || 0) + Number(p.amount ?? 0);
      });

      const categoryBreakdown = Object.entries(categoryMap).map(
        ([category, amount]) => ({
          category: category
            .replace(/_/g, " ")
            .toLowerCase()
            .replace(/\b\w/g, (l) => l.toUpperCase()),
          amount,
        }),
      );

      // Get invoice count
      const invoiceCount = await prisma.invoice.count({
        where: {
          application: {
            status: {
              in: [ApplicationStatus.submitted, ApplicationStatus.under_review],
            },
          },
        },
      });

      return {
        metrics: {
          totalRevenue,
          pendingAmount,
          activeOfficers,
          transactionCount: confirmedPayments.length,
          invoiceGeneratedCount: invoiceCount,
          pendingInvoiceCount: pendingInvoices.length,
        },
        revenueTrend,
        serviceBreakdown,
        categoryBreakdown,
      };
    }

    case ("sub_admin" as Role): {
      const [
        totalApplications,
        pendingFirstReview,
        correctionsRequested,
        forwardedToFinal,
        pendingPaymentProofs,
        recentApplications,
      ] = await Promise.all([
        prisma.application.count(),
        prisma.application.count({ where: { status: ApplicationStatus.submitted } }),
        prisma.application.count({ where: { status: "correction_requested" as any } }),
        prisma.application.count({ where: { status: ApplicationStatus.under_review } }),
        prisma.application.count({ where: { status: ApplicationStatus.awaiting_payment_confirmation } }),
        prisma.application.findMany({
          orderBy: { createdAt: "desc" },
          take: 10,
          include: {
            service: { select: { id: true, name: true, code: true } },
            applicant: { select: { firstName: true, lastName: true, email: true, phone: true } },
          },
        }),
      ]);

      return {
        metrics: {
          totalApplications,
          pendingFirstReview,
          correctionsRequested,
          forwardedToFinal,
          pendingPaymentProofs,
        },
        recentApplications,
      };
    }

    case Role.lga_admin:
    case Role.super_admin: {
      const [totalApplications, totalUsers, activeFieldOfficers, auditEvents] =
        await Promise.all([
          prisma.application.count(),
          prisma.user.count(),
          prisma.user.count({
            where: { role: Role.field_officer, isActive: true },
          }),
          prisma.auditLog.count(),
        ]);

      return {
        metrics: {
          totalApplications,
          totalUsers,
          activeFieldOfficers,
          auditEvents,
        },
      };
    }

    case Role.field_officer: {
      const [apps, recentApps] = await Promise.all([
        prisma.application.findMany({
          where: { createdById: userId },
          select: { id: true, status: true },
        }),
        prisma.application.findMany({
          where: { createdById: userId },
          include: { service: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
          take: 5,
        }),
      ]);

      const counts = apps.reduce(
        (acc: Record<string, number>, a) => {
          acc[a.status] = (acc[a.status] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      return {
        metrics: {
          totalSubmitted: apps.length,
          submitted: counts[ApplicationStatus.submitted] ?? 0,
          underReview: counts[ApplicationStatus.under_review] ?? 0,
          approved: counts[ApplicationStatus.approved] ?? 0,
          declined: counts[ApplicationStatus.declined] ?? 0,
        },
        recentApplications: recentApps.map((a) => ({
          id: a.id,
          applicationNumber: a.applicationNumber,
          service: a.service?.name,
          status: a.status,
        })),
      };
    }

    case Role.ward_councillor: {
      const wardId = user.wardId;
      let ward = wardId ? await prisma.ward.findUnique({ where: { id: wardId } }) : null;
      if (!ward) {
        ward = await prisma.ward.findFirst();
      }

      let totalConstituents = 0;
      if (wardId) {
        totalConstituents = await prisma.user.count({
          where: { role: Role.citizen, wardId },
        });
      }
      if (totalConstituents === 0) {
        totalConstituents = await prisma.user.count({
          where: { role: Role.citizen },
        });
      }

      const pendingStatuses = [
        ApplicationStatus.submitted,
        ApplicationStatus.under_review,
        ApplicationStatus.awaiting_payment_confirmation,
        ApplicationStatus.payment_pending,
      ];

      const [pendingApprovals, approvedSOO, totalComplaints, recentApps] =
        await Promise.all([
          prisma.application.count({
            where: {
              status: { in: pendingStatuses },
            },
          }),
          prisma.application.count({
            where: {
              status: ApplicationStatus.approved,
            },
          }),
          prisma.complaint.count({
            where: {
              status: { not: ComplaintStatus.closed },
            },
          }),
          prisma.application.findMany({
            include: {
              service: { select: { code: true, name: true } },
              applicant: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  ward: { select: { name: true } },
                },
              },
            },
            orderBy: { createdAt: "desc" },
            take: 10,
          }),
        ]);

      const formattedApplications = recentApps.map((app) => {
        const formDataWard =
          (app.formData as any)?.ward || (app.formData as any)?.wardOfOrigin;
        return {
          id: app.applicationNumber || app.id.slice(0, 8),
          applicant: app.applicant
            ? `${app.applicant.firstName} ${app.applicant.lastName}`
            : "Citizen Applicant",
          ward: app.applicant?.ward?.name || formDataWard || ward?.name || "Agbado",
          status: app.status,
        };
      });

      return {
        metrics: {
          totalConstituents,
          pendingApprovals,
          approvedSOO,
          totalComplaints,
        },
        applications: formattedApplications,
        ward: ward ? { id: ward.id, name: ward.name, code: ward.code } : null,
      };
    }

    case Role.auditor: {
      const [
        confirmedPaymentsAgg,
        outstandingInvoices,
        receiptsCount,
        auditEventsCount,
        activeOfficers,
        paymentMethods,
        recentAudits,
        anomalies,
        highValueTransactions,
        // Add cash and digital payment aggregates
        cashPaymentsAgg,
        digitalPaymentsAgg,
      ] = await Promise.all([
        prisma.payment.aggregate({
          where: { status: PaymentStatus.confirmed },
          _sum: { amount: true },
        }),
        prisma.invoice.findMany({
          where: { paymentStatus: { not: PaymentStatus.confirmed } },
          select: {
            id: true,
            amount: true,
            invoiceNumber: true,
            createdAt: true,
          },
        }),
        prisma.receipt.count(),
        prisma.auditLog.count({
          where: {
            createdAt: {
              gte: new Date(new Date().setDate(new Date().getDate() - 30)),
            },
          },
        }),
        prisma.user.count({
          where: { role: Role.field_officer, isActive: true },
        }),
        prisma.payment.groupBy({
          by: ["method"],
          where: { status: PaymentStatus.confirmed },
          _sum: { amount: true },
        }),
        // Recent audit logs
        prisma.auditLog.findMany({
          where: {
            createdAt: {
              gte: new Date(new Date().setDate(new Date().getDate() - 7)),
            },
          },
          orderBy: { createdAt: "desc" },
          take: 5,
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
                email: true,
                role: true,
              },
            },
          },
        }),
        // Anomalies - failed payments
        prisma.payment.findMany({
          where: {
            status: PaymentStatus.failed,
            createdAt: {
              gte: new Date(new Date().setDate(new Date().getDate() - 7)),
            },
          },
          orderBy: { createdAt: "desc" },
          take: 5,
          include: {
            invoice: {
              include: {
                service: true,
                application: {
                  include: {
                    applicant: {
                      select: {
                        firstName: true,
                        lastName: true,
                        email: true,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        // High value transactions
        prisma.payment.findMany({
          where: {
            status: PaymentStatus.confirmed,
            amount: {
              gt: 100000,
            },
            createdAt: {
              gte: new Date(new Date().setDate(new Date().getDate() - 7)),
            },
          },
          orderBy: { amount: "desc" },
          take: 5,
          include: {
            invoice: {
              include: {
                service: true,
                application: {
                  include: {
                    applicant: {
                      select: {
                        firstName: true,
                        lastName: true,
                        email: true,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        // Cash payments aggregate (POS and Cash)
        prisma.payment.aggregate({
          where: {
            status: PaymentStatus.confirmed,
            method: {
              in: [PaymentMethod.pos, PaymentMethod.cash],
            },
          },
          _sum: { amount: true },
        }),
        // Digital payments aggregate (online_gateway, bank_transfer, virtual_account)
        prisma.payment.aggregate({
          where: {
            status: PaymentStatus.confirmed,
            method: {
              in: [
                PaymentMethod.online_gateway,
                PaymentMethod.bank_transfer,
                PaymentMethod.virtual_account,
              ],
            },
          },
          _sum: { amount: true },
        }),
      ]);

      const totalCollected = Number(confirmedPaymentsAgg._sum.amount ?? 0);
      const outstanding = outstandingInvoices.reduce(
        (s, i) => s + Number(i.amount ?? 0),
        0,
      );
      const cashCollected = Number(cashPaymentsAgg._sum.amount ?? 0);
      const digitalCollected = Number(digitalPaymentsAgg._sum.amount ?? 0);

      // Transform anomalies to match UI expectations
      const transformedAnomalies = anomalies.map((p) => ({
        id: p.id,
        type: "Failed Payment",
        description: `Failed payment of ₦${Number(p.amount).toLocaleString()} for ${p.invoice.service.name}`,
        severity: p.status === PaymentStatus.failed ? "high" : "medium",
        date: p.createdAt,
        status: p.status,
        applicationId: p.invoice.applicationId,
        amount: Number(p.amount),
        applicantName: p.invoice.application?.applicant
          ? `${p.invoice.application.applicant.firstName} ${p.invoice.application.applicant.lastName}`
          : "Unknown",
        serviceName: p.invoice.service.name,
      }));

      // Transform high value transactions
      const transformedHighValueTransactions = highValueTransactions.map(
        (p) => ({
          id: p.id,
          amount: Number(p.amount),
          date: p.createdAt,
          applicantName: p.invoice.application?.applicant
            ? `${p.invoice.application.applicant.firstName} ${p.invoice.application.applicant.lastName}`
            : "Unknown",
          serviceName: p.invoice.service.name,
          status: p.status,
          reference: p.reference,
        }),
      );

      // Transform recent audits
      const transformedRecentAudits = recentAudits.map((log) => ({
        id: log.id,
        action: log.action,
        entity: log.entity || "System",
        details: log.details || {},
        createdAt: log.createdAt,
        actorRole: log.user?.role || "System",
        actor: log.user
          ? `${log.user.firstName} ${log.user.lastName}`
          : "System",
        ipAddress: log.ipAddress,
      }));

      return {
        metrics: {
          totalCollected,
          outstanding,
          receiptsCount,
          auditEvents: auditEventsCount,
          activeOfficers,
          cashCollected,
          digitalCollected,
        },
        anomalies: transformedAnomalies,
        highValueTransactions: transformedHighValueTransactions,
        recentAudits: transformedRecentAudits,
        paymentMethods: paymentMethods.map((p) => ({
          method: p.method,
          amount: Number(p._sum.amount ?? 0),
        })),
      };
    }

    default:
      return {
        message: "No specific metrics defined for this role.",
        metrics: {},
      };
  }
};

import { Request, Response, NextFunction } from "express";
export const getDashboardOverview = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // Safely extract token payload properties
    const { id: userId, role } = (req as any).user as {
      id: string;
      role: Role;
    };

    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      sendError(
        res,
        "User record profile could not be localized",
        "NOT_FOUND",
        null,
        404,
      );
      return;
    }

    // Invoke our extracted service helper
    const payload = await fetchMetricsByRole(role, userId, user);

    res.status(200).json({
      success: true,
      role,
      ...payload,
    });
  } catch (error: any) {
    // If our service threw a profile validation error, catch it gracefully
    if (error.message?.includes("missing")) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
};

import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { sendError } from "../../utils/response";
// Adjust to your auth file location

const router = Router();

// Protect endpoint with your standard access token decoding middleware
router.get("/overview", requireAuth, getDashboardOverview);

export default router;
