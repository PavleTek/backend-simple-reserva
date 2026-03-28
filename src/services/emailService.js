const { Resend } = require("resend");
const prisma = require("../lib/prisma");

let resendClient = null;

function ensureResendClient() {
  if (resendClient) {
    return resendClient;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("[Resend] RESEND_API_KEY is not configured");
    throw new Error("Resend API key is required. Please set RESEND_API_KEY in your environment.");
  }

  resendClient = new Resend(apiKey);
  return resendClient;
}

function normalizeEmailList(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value
      .map((email) => (typeof email === "string" ? email.trim() : email))
      .filter((email) => typeof email === "string" && email.length > 0);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function normalizeAttachments(attachments) {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  return attachments
    .map((attachment) => {
      const filename = attachment?.filename || attachment?.name;
      const mimeType = attachment?.contentType || attachment?.mimeType || attachment?.type;

      let bufferContent = attachment?.content || attachment?.data || attachment?.buffer;
      if (!bufferContent) {
        return null;
      }

      if (typeof bufferContent === "string") {
        return {
          filename,
          content: bufferContent,
          mime_type: mimeType,
        };
      }

      if (!Buffer.isBuffer(bufferContent)) {
        bufferContent = Buffer.from(bufferContent);
      }

      return {
        filename: filename || "attachment",
        content: bufferContent.toString("base64"),
        mime_type: mimeType,
      };
    })
    .filter(Boolean);
}

async function sendViaResend(options) {
  const resend = ensureResendClient();

  const toList = normalizeEmailList(options.toEmails);
  const ccList = normalizeEmailList(options.ccEmails);
  const bccList = normalizeEmailList(options.bccEmails);

  if (toList.length === 0) {
    throw new Error("At least one recipient email is required to send via Resend.");
  }

  const payload = {
    from: options.fromEmail,
    to: toList,
    subject: options.subject,
    ...(options.isHtml ? { html: options.content } : { text: options.content }),
  };

  if (ccList.length > 0) {
    payload.cc = ccList;
  }

  if (bccList.length > 0) {
    payload.bcc = bccList;
  }

  const resendAttachments = normalizeAttachments(options.attachments);
  if (resendAttachments.length > 0) {
    payload.attachments = resendAttachments;
  }

  try {
    const response = await resend.emails.send(payload);
    return response;
  } catch (error) {
    console.error("[sendViaResend] Failed to send email via Resend:", {
      message: error.message,
      statusCode: error?.statusCode,
    });
    throw error;
  }
}

async function sendEmail(options) {
  const { fromEmail, toEmails, subject, content } = options;

  if (!fromEmail || !toEmails || !subject || !content) {
    throw new Error("Missing required email parameters: fromEmail, toEmails, subject, and content are required");
  }

  const normalizedFromEmail = fromEmail.toLowerCase().trim();

  console.log('[Email] sendEmail: lookup sender in DB', { fromEmail: normalizedFromEmail });

  const emailSender = await prisma.emailSender.findUnique({
    where: { email: normalizedFromEmail },
  });

  if (!emailSender) {
    console.error('[Email] sendEmail: sender not found in emailSender table — add it via Admin or set reservationEmailSenderId in Configuration', {
      fromEmail: normalizedFromEmail,
    });
    throw new Error(`Email sender ${fromEmail} not found in database. Please add it first.`);
  }

  console.log('[Email] sendEmail: sending via Resend', {
    from: normalizedFromEmail,
    to: Array.isArray(toEmails) ? toEmails : [toEmails],
    subject,
  });

  const normalizedOptions = {
    ...options,
    fromEmail: normalizedFromEmail,
    toEmails,
    ccEmails: options.ccEmails,
    bccEmails: options.bccEmails,
    isHtml: options.isHtml || false,
  };

  try {
    const result = await sendViaResend(normalizedOptions);
    console.log('[Email] sendEmail: Resend accepted', {
      to: Array.isArray(toEmails) ? toEmails : [toEmails],
      subject,
      resendId: result?.data?.id || result?.id || '(no id)',
    });
    return result;
  } catch (error) {
    console.error("[Email] sendEmail: Resend error", {
      message: error.message,
      statusCode: error?.statusCode,
      from: normalizedFromEmail,
      to: Array.isArray(toEmails) ? toEmails : [toEmails],
    });
    throw error;
  }
}

module.exports = {
  sendEmail,
  sendViaResend,
};
