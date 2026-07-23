#!/usr/bin/env node
'use strict';

/**
 * Backfill evidencia de registro (términos, IP, correo bienvenida) para orgs existentes.
 *
 * Uso:
 *   node scripts/backfill-signup-evidence.js                         # dry-run (DATABASE_URL)
 *   node scripts/backfill-signup-evidence.js --apply                 # escribe
 *   node scripts/backfill-signup-evidence.js --org-id cmr10eeak...   # una org
 *   node scripts/backfill-signup-evidence.js --railway-log-file ./logs.txt
 *   DATABASE_URL=postgres://... node scripts/backfill-signup-evidence.js --apply
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const prisma = require('../src/lib/prisma');
const { resolveTermsVersionForDate, CURRENT_TERMS_VERSION } = require('../src/lib/termsVersion');
const {
  WELCOME_EMAIL_KIND,
  WELCOME_EMAIL_SUBJECT,
} = require('../src/services/signupEvidenceService');

const APPLY = process.argv.includes('--apply');
const ORG_ID = (() => {
  const idx = process.argv.indexOf('--org-id');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();
const RAILWAY_LOG_FILE = (() => {
  const idx = process.argv.indexOf('--railway-log-file');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

const REGISTRANT_WINDOW_MS = 10_000;

/** @type {Map<string, { ip?: string, userAgent?: string, email?: string }>} */
const railwayRegisterHints = new Map();

/** @type {Map<string, { resendId?: string, sentAt?: Date }>} */
const resendWelcomeByEmail = new Map();

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

function loadRailwayLogFile(filePath) {
  if (!filePath) return;
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    console.warn(`[warn] Railway log file not found: ${abs}`);
    return;
  }
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split('\n');

  for (const line of lines) {
    // Nuevo formato estructurado
    const successMatch = line.match(/\[AUTH\] Register success.*organizationId[":'\s]+([a-z0-9]+)/i);
    if (successMatch) {
      const orgId = successMatch[1];
      const ipMatch = line.match(/ip[":'\s]+([0-9a-f.:]+)/i);
      const emailMatch = line.match(/email[":'\s]+([^\s"',}]+@[^\s"',}]+)/i);
      const hint = railwayRegisterHints.get(orgId) || {};
      if (ipMatch) hint.ip = ipMatch[1];
      if (emailMatch) hint.email = normalizeEmail(emailMatch[1]);
      railwayRegisterHints.set(orgId, hint);
    }

    // Resend accepted welcome
    if (line.includes('Bienvenido a SimpleReserva') || line.includes(WELCOME_EMAIL_SUBJECT)) {
      const toMatch = line.match(/to:\s*\[\s*'([^']+)'/i) || line.match(/"to"\s*:\s*\[\s*"([^"]+)"/i);
      const resendMatch = line.match(/resendId[":'\s]+([a-z0-9-]+)/i);
      if (toMatch) {
        const email = normalizeEmail(toMatch[1]);
        const hint = resendWelcomeByEmail.get(email) || {};
        if (resendMatch) hint.resendId = resendMatch[1];
        resendWelcomeByEmail.set(email, hint);
      }
    }
  }

  console.log(`Railway log hints: ${railwayRegisterHints.size} register, ${resendWelcomeByEmail.size} welcome emails`);
}

async function fetchResendWelcomeEmails() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('RESEND_API_KEY no configurada — omitiendo búsqueda en Resend API.');
    return;
  }

  let cursor = null;
  let pages = 0;
  const maxPages = 20;

  while (pages < maxPages) {
    const url = new URL('https://api.resend.com/emails');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('after', cursor);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.warn(`[warn] Resend API ${res.status}: ${await res.text()}`);
      break;
    }
    const body = await res.json();
    const items = body.data || [];
    if (!items.length) break;

    for (const item of items) {
      const subject = item.subject || '';
      if (!subject.includes('Bienvenido a SimpleReserva')) continue;
      const recipients = Array.isArray(item.to) ? item.to : [item.to].filter(Boolean);
      for (const raw of recipients) {
        const email = normalizeEmail(raw);
        resendWelcomeByEmail.set(email, {
          resendId: item.id,
          sentAt: item.created_at ? new Date(item.created_at) : undefined,
        });
      }
    }

    cursor = items[items.length - 1]?.id;
    pages += 1;
    if (items.length < 100) break;
  }

  console.log(`Resend API: ${resendWelcomeByEmail.size} correos de bienvenida indexados`);
}

async function findRegistrantUser(org) {
  const windowStart = new Date(org.createdAt.getTime() - REGISTRANT_WINDOW_MS);
  const windowEnd = new Date(org.createdAt.getTime() + REGISTRANT_WINDOW_MS);

  const transfer = await prisma.ownershipTransfer.findFirst({
    where: { organizationId: org.id, status: 'accepted' },
    orderBy: { createdAt: 'asc' },
    include: { fromOwner: true },
  });
  if (transfer?.fromOwner) {
    return { user: transfer.fromOwner, source: 'ownership_transfer_from_owner' };
  }

  if (org.ownerId) {
    const owner = await prisma.user.findUnique({ where: { id: org.ownerId } });
    if (owner && owner.createdAt >= windowStart && owner.createdAt <= windowEnd) {
      return { user: owner, source: 'org_owner_at_signup' };
    }
  }

  const managers = await prisma.organizationManager.findMany({
    where: { organizationId: org.id },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const m of managers) {
    if (m.user.createdAt >= windowStart && m.user.createdAt <= windowEnd) {
      return { user: m.user, source: 'early_manager_at_signup' };
    }
  }

  if (org.ownerId) {
    const owner = await prisma.user.findUnique({ where: { id: org.ownerId } });
    if (owner) return { user: owner, source: 'current_owner_fallback' };
  }

  return { user: null, source: 'unknown' };
}

async function backfillOrg(org) {
  const existingWelcome = await prisma.organizationSignupEmailLog.findFirst({
    where: { organizationId: org.id, kind: WELCOME_EMAIL_KIND },
  });

  const referral = await prisma.referral.findUnique({
    where: { refereeOrganizationId: org.id },
  });

  const { user: registrant, source: registrantSource } = await findRegistrantUser(org);
  const railwayHint = railwayRegisterHints.get(org.id) || {};
  const termsVersion = org.signupTermsVersion || resolveTermsVersionForDate(org.createdAt);
  const termsAcceptedAt = org.signupTermsAcceptedAt || registrant?.createdAt || org.createdAt;

  const signupIp =
    org.signupIp ||
    referral?.signupIp ||
    railwayHint.ip ||
    null;

  const signupUserAgent =
    org.signupUserAgent ||
    referral?.signupUserAgent ||
    null;

  const welcomeEmail = registrant?.email || railwayHint.email || org.owner?.email || null;
  const resendHint = welcomeEmail ? resendWelcomeByEmail.get(normalizeEmail(welcomeEmail)) : null;

  const patch = {
    signupRegisteredByUserId: org.signupRegisteredByUserId || registrant?.id || null,
    signupTermsAcceptedAt: termsAcceptedAt,
    signupTermsVersion: termsVersion,
    signupIp,
    signupUserAgent,
  };

  const welcomeLog = existingWelcome
    ? null
    : welcomeEmail
      ? {
          organizationId: org.id,
          kind: WELCOME_EMAIL_KIND,
          recipientEmail: welcomeEmail,
          subject: WELCOME_EMAIL_SUBJECT,
          status: 'sent',
          resendId: resendHint?.resendId || null,
          sentAt: resendHint?.sentAt || termsAcceptedAt,
          source: 'backfill',
          metadata: {
            registrantSource,
            inferredFrom: resendHint?.resendId
              ? 'resend_api_or_railway_log'
              : 'register_flow_sendOrganizationOwnerWelcomeEmail',
            note: signupIp
              ? 'IP desde referral o logs Railway'
              : 'IP no disponible en logs históricos de Railway (retención limitada)',
            termsVersionNote:
              termsVersion === CURRENT_TERMS_VERSION
                ? 'Versión publicada en simplereserva.com/terminos'
                : 'Versión pre-publicación vigente al momento del registro',
          },
        }
      : null;

  return {
    orgId: org.id,
    orgName: org.name,
    patch,
    welcomeLog,
    registrantEmail: welcomeEmail,
    registrantSource,
    hasExistingWelcome: Boolean(existingWelcome),
    skippedFields: {
      signupTermsAcceptedAt: Boolean(org.signupTermsAcceptedAt),
      signupIp: Boolean(org.signupIp),
    },
  };
}

async function main() {
  loadRailwayLogFile(RAILWAY_LOG_FILE);
  await fetchResendWelcomeEmails();

  const orgs = await prisma.restaurantOrganization.findMany({
    where: {
      isDeleted: false,
      ...(ORG_ID ? { id: ORG_ID } : {}),
    },
    include: {
      owner: { select: { id: true, email: true, createdAt: true } },
      restaurants: { select: { name: true, slug: true }, take: 1 },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (!orgs.length) {
    console.log('No hay organizaciones para backfill.');
    return;
  }

  console.log(`${APPLY ? 'APLICAR' : 'DRY-RUN'}: ${orgs.length} organización(es)\n`);

  let updated = 0;
  let welcomeCreated = 0;

  for (const org of orgs) {
    const plan = await backfillOrg(org);
    const restaurantLabel = org.restaurants[0]?.slug || org.restaurants[0]?.name || '—';

    console.log(`— ${plan.orgName} (${restaurantLabel})`);
    console.log(`  registrant: ${plan.registrantEmail || '—'} [${plan.registrantSource}]`);
    console.log(`  terms: ${plan.patch.signupTermsVersion} @ ${plan.patch.signupTermsAcceptedAt?.toISOString()}`);
    console.log(`  ip: ${plan.patch.signupIp || '(sin dato)'}`);
    if (plan.welcomeLog) {
      console.log(`  welcome log: ${plan.welcomeLog.recipientEmail} resendId=${plan.welcomeLog.resendId || '—'}`);
    } else if (plan.hasExistingWelcome) {
      console.log('  welcome log: ya existe');
    } else {
      console.log('  welcome log: omitido (sin email registrante)');
    }

    const needsOrgUpdate =
      !org.signupTermsAcceptedAt ||
      !org.signupRegisteredByUserId ||
      (!org.signupIp && plan.patch.signupIp);

    if (needsOrgUpdate || plan.welcomeLog) {
      if (APPLY) {
        if (needsOrgUpdate) {
          await prisma.restaurantOrganization.update({
            where: { id: org.id },
            data: plan.patch,
          });
        }
        if (plan.welcomeLog) {
          await prisma.organizationSignupEmailLog.create({ data: plan.welcomeLog });
        }
      }
      if (needsOrgUpdate) updated += 1;
      if (plan.welcomeLog) welcomeCreated += 1;
    } else {
      console.log('  → sin cambios');
    }
    console.log('');
  }

  console.log(`Resumen: ${updated} org(s) ${APPLY ? 'actualizadas' : 'a actualizar'}, ${welcomeCreated} welcome log(s) ${APPLY ? 'creados' : 'a crear'}.`);
  if (!APPLY) console.log('Ejecuta con --apply para persistir.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
