// src/notifications/email.service.ts
// Sends email via cPanel mailbox using nodemailer + SMTP.
// npm install nodemailer && npm install -D @types/nodemailer

import nodemailer from "nodemailer";

const {
  SMTP_HOST,          // Try '127.0.0.1' if domain fails due to firewall rules
  SMTP_PORT = "587",  
  SMTP_USER,          
  SMTP_PASS,
  SMTP_FROM_NAME = "Ijebu North East LGA",
} = process.env;

const isPort465 = Number(SMTP_PORT) === 465;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: isPort465, // True for 465, false for other ports
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
  // 💡 Add TLS fallback options to handle self-signed certificates or proxy hooks on cPanel
  tls: {
    rejectUnauthorized: false, // Prevents timeouts on internal local-routing handshakes
  },
  // The shared Exim server delays its SMTP greeting by roughly 28 seconds
  // (measured Nov 2026) as an anti-spam measure. Nodemailer's default
  // greeting timeout is 30 seconds, which made sends fail intermittently
  // with "Greeting never received". These timeouts give the server room.
  greetingTimeout: 90000,
  connectionTimeout: 90000,
  socketTimeout: 90000,
});

// Verify SMTP connection on startup
export async function verifyConnection(): Promise<boolean> {
    try {
        // 💡 Ensure all required SMTP env variables are loaded before verification
        if (!SMTP_HOST) throw new Error("SMTP_HOST is not defined in .env");
        if (!SMTP_USER) throw new Error("SMTP_USER is not defined in .env");
        if (!SMTP_PASS) throw new Error("SMTP_PASS is not defined in .env");
        if (!SMTP_PORT) throw new Error("SMTP_PORT is not defined in .env");
        
        await transporter.verify();
        console.log("[email.service] SMTP connection verified");
        console.log(`[email.service] Using SMTP: ${SMTP_HOST}:${SMTP_PORT} as ${SMTP_USER}`);
        return true;
    } catch (err: any) {
        console.error("[email.service] SMTP verification failed:", err.message);
        console.error("[email.service] Check your .env file for: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS");
        return false;
    }
}

interface SendEmailParams {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: nodemailer.SendMailOptions["attachments"];
}

interface SendEmailResult {
  success: boolean;
  data?: { messageId: string; accepted: unknown };
  error?: string;
}

export async function sendEmail({
  to,
  subject,
  html,
  text,
  attachments,
}: SendEmailParams): Promise<SendEmailResult> {
  if (!to || !subject || (!html && !text)) {
    return { success: false, error: "`to`, `subject`, and `html` or `text` are required" };
  }

  try {
    const info = await transporter.sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_USER}>`,
      to,
      subject,
      html,
      text,
      attachments,
    });

    return { success: true, data: { messageId: info.messageId, accepted: info.accepted } };
  } catch (err: any) {
    console.error("[email.service] sendEmail error:", err);
    return { success: false, error: err.message };
  }
}