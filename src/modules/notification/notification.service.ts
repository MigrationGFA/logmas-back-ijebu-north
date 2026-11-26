// src/notifications/notification.service.ts — REPLACES the previous version

import { sendSms } from "./sms.service";
import { sendEmail } from "./email.service";
import {
  NotificationTemplates,
  interpolate,
  TemplateVars,
} from "../../config/notification.template";
import { prisma } from "../../utils/prisma";

type Channel = "sms" | "email"; // in-app is implicit, not something you "request" anymore

interface NotifyParams {
  userId: string;
  to: { phone?: string; email?: string };
  templateKey: string;
  vars: TemplateVars;
  channels: Channel[]; // which EXTRA channels to attempt beyond the always-on in-app row
}

interface ResolvedTemplate {
  sms?: string;
  emailSubject?: string;
  emailHtml?: string;
}

function resolveTemplate(templateKey: string): ResolvedTemplate {
  const parts = templateKey.split(".");
  let node: any = NotificationTemplates;
  for (const part of parts) node = node?.[part];
  if (!node) throw new Error(`Template not found for key "${templateKey}"`);
  return node as ResolvedTemplate;
}

function stringifyError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error == null) return "Unknown error";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// Picks whatever text makes sense for the in-app feed — prefers the email
// subject as a "title" and the sms text (usually the shortest, cleanest
// summary) as the body, falling back sensibly if only one exists.
function buildInAppContent(template: ResolvedTemplate, vars: TemplateVars) {
  const title = template.emailSubject
    ? interpolate(template.emailSubject, vars)
    : undefined;
  const message = template.sms
    ? interpolate(template.sms, vars)
    : template.emailSubject
      ? interpolate(template.emailSubject, vars)
      : "You have a new notification.";
  return { title, message };
}

/**
 * Resolves which external channels (email / sms) should actually be used for a
 * user, based on their stored notification preferences.
 *
 * A requested channel is only kept when the user has the matching preference
 * enabled:
 *  - `notifyByEmail` -> email is kept
 *  - `notifyBySms`   -> sms is kept
 * If the user has NEITHER email nor SMS selected, the returned array is empty so
 * no external notification is sent at all (in-app rows are unaffected).
 *
 * @param userId   The target user id (preferences are read from the User row).
 * @param channels The channels that were requested for this notification.
 * @returns Only the channels the user has explicitly opted into.
 */
export async function resolvePreferredChannels(
  userId: string,
  channels: Channel[],
): Promise<Channel[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notifyByEmail: true, notifyBySms: true },
  });

  const enabled: Channel[] = [];
  if (channels.includes("email") && (user?.notifyByEmail ?? true))
    enabled.push("email");
  if (channels.includes("sms") && (user?.notifyBySms ?? true))
    enabled.push("sms");
  return enabled;
}

export async function notify({
  userId,
  to,
  templateKey,
  vars,
  channels,
}: NotifyParams) {
  const template = resolveTemplate(templateKey);

  // Only send the channels the user has actually opted into (email / sms).
  const preferred = await resolvePreferredChannels(userId, channels);

  const wantsSms = preferred.includes("sms");
  const wantsEmail = preferred.includes("email");

  const smsEnabled = wantsSms && !!to.phone && !!template.sms;
  const emailEnabled =
    wantsEmail && !!to.email && !!template.emailHtml && !!template.emailSubject;

  const { title, message } = buildInAppContent(template, vars);

  // ── One row, created up front as "pending" for whichever channels apply ──
  const record = await prisma.notification.create({
    data: {
      user: { connect: { id: userId } },
      templateKey,
      title,
      message,
      smsStatus: wantsSms ? (smsEnabled ? "pending" : "failed") : null,
      emailStatus: wantsEmail ? (emailEnabled ? "pending" : "failed") : null,
    },
  });

  // ── Fire whatever's enabled in parallel ──
  const [smsResult, emailResult] = await Promise.all([
    smsEnabled
      ? sendSms({ to: to.phone!, message: interpolate(template.sms!, vars) })
      : null,
    emailEnabled
      ? sendEmail({
          to: to.email!,
          subject: interpolate(template.emailSubject!, vars),
          html: interpolate(template.emailHtml!, vars),
        })
      : null,
  ]);

  // ── One update, writing back both channel outcomes at once ──
  await prisma.notification.update({
    where: { id: record.id },
    data: {
      ...(smsResult
        ? smsResult.success
          ? { smsStatus: "sent", smsSentAt: new Date() }
          : {
              smsStatus: "failed",
              smsFailReason: stringifyError(smsResult.error),
            }
        : {}),
      ...(emailResult
        ? emailResult.success
          ? { emailStatus: "sent", emailSentAt: new Date() }
          : {
              emailStatus: "failed",
              emailFailReason: stringifyError(emailResult.error),
            }
        : {}),
    },
  });

  return {
    notificationId: record.id,
    sms: smsEnabled
      ? { success: smsResult!.success, error: smsResult!.error, skipped: false }
      : wantsSms
        ? { success: false, skipped: true }
        : undefined,
    email: emailEnabled
      ? {
          success: emailResult!.success,
          error: emailResult!.error,
          skipped: false,
        }
      : wantsEmail
        ? { success: false, skipped: true }
        : undefined,
  };
}

/**
 * Citizen lifecycle notifications (submitted, approved, declined,
 * complete your application) belong to real applicant accounts. In
 * assisted creation a staff account becomes the applicant of record
 * only as a fallback, because the walk-up user has no account; those
 * staff must not receive the citizen's notifications.
 */
export function isPublicApplicant(
  user?: { role?: string | null } | null,
): boolean {
  return !!user && (user.role === "citizen" || user.role === "business_owner");
}

/**
 * Tell the field officer who attended to an application (created or
 * assisted it) that it was declined or rejected, so he learns the
 * outcome of work he handled without watching the dashboard. Covers
 * assisted citizen applications and his own FO collections alike: in
 * both, the officer is the application's creator. Never throws.
 */
export async function notifyOfficerApplicationDeclined(
  application: {
    id: string;
    applicationNumber: string;
    createdById?: string | null;
    service?: { name?: string } | null;
  },
  declineReason: string,
): Promise<void> {
  try {
    if (!application?.createdById) return;
    const creator = await prisma.user.findUnique({
      where: { id: application.createdById },
      select: {
        id: true,
        role: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
      },
    });
    if (!creator || creator.role !== "field_officer") return;
    await notify({
      userId: creator.id,
      to: { email: creator.email, phone: creator.phone ?? "" },
      templateKey: "application.officerApplicationDeclined",
      vars: {
        officer_name: `${creator.firstName} ${creator.lastName}`,
        application_number: application.applicationNumber,
        service_name: application.service?.name ?? "LGA Service",
        application_id: application.id,
        decline_reason: declineReason,
      },
      channels: ["email", "sms"],
    });
  } catch (err) {
    console.error(
      "[notifyOfficerApplicationDeclined] failed, continuing:",
      err,
    );
  }
}
