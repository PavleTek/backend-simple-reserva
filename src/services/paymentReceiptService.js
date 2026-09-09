const prisma = require('../lib/prisma');
const { parsePagination, paginatedResponse } = require('../utils/pagination');

/**
 * Creates a PaymentReceipt from MercadoPago payment data.
 * 
 * @param {Object} paymentData - Data from MercadoPago Payment API
 * @param {string} organizationId - Target organization
 * @param {string} planSKU - Plan SKU
 */
async function createReceiptFromMPPayment(paymentData, organizationId, planSKU) {
  const {
    id,
    transaction_amount,
    currency_id,
    date_approved,
    status,
    payer,
  } = paymentData;

  // Check if receipt already exists (idempotency)
  const existing = await prisma.paymentReceipt.findUnique({
    where: { mercadopagoPaymentId: String(id) },
  });
  if (existing) return existing;

  // Find organization and its billing settings
  const organization = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    include: { plan: true },
  });
  if (!organization) throw new Error(`Organization ${organizationId} not found`);

  // Find plan
  const plan = await prisma.plan.findUnique({
    where: { productSKU: planSKU },
  });
  if (!plan) throw new Error(`Plan ${planSKU} not found`);

  // Find active subscription for this organization
  const subscription = await prisma.subscription.findFirst({
    where: { 
      organizationId,
      status: { in: ['active', 'grace', 'cancelled'] },
    },
    orderBy: { startDate: 'desc' },
  });

  // Create the receipt
  const receipt = await prisma.paymentReceipt.create({
    data: {
      organizationId,
      subscriptionId: subscription?.id,
      planId: plan.id,
      amount: transaction_amount,
      currency: currency_id,
      paymentDate: new Date(date_approved),
      receiptType: organization.billingType || 'boleta',
      clientName: payer?.first_name && payer?.last_name ? `${payer.first_name} ${payer.last_name}` : (payer?.email || null),
      clientEmail: payer?.email || organization.billingEmail,
      clientTaxId: organization.billingTaxId,
      clientBusinessName: organization.billingBusinessName,
      clientAddress: organization.billingAddress,
      mercadopagoPaymentId: String(id),
      mercadopagoStatus: status,
    },
    include: { plan: true, organization: true },
  });

  try {
    const { persistPaymentMethodSnapshot } = require('./billing/paymentMethodSnapshot');
    await persistPaymentMethodSnapshot(organizationId, paymentData);
  } catch (snapErr) {
    console.warn('[PaymentReceipt] snapshot error:', snapErr?.message);
  }

  if (status === 'approved') {
    try {
      const { generateReceiptPdf } = require('./billing/receiptPdfGenerator');
      const { sendPaymentApprovedEmail } = require('./billing/billingTransactionalEmailService');
      const pdfBuffer = await generateReceiptPdf(receipt, receipt.organization, receipt.plan);
      await sendPaymentApprovedEmail({
        organizationId,
        planName: plan.name,
        amountCLP: Number(transaction_amount),
        currency: currency_id,
        pdfBuffer,
      });
    } catch (emailErr) {
      console.warn('[PaymentReceipt] payment approved email error:', emailErr?.message);
    }
  }

  return receipt;
}

/**
 * Creates a PaymentReceipt from a Flow payment/getStatus payload.
 * Idempotent on flowOrder. Writes mercadopagoStatus='approved' so existing
 * /billing/payments + InvoicesTable status mapping still works.
 */
async function createReceiptFromFlowPayment(flowPayment, organizationId, extras = {}) {
  const flowOrder = flowPayment?.flowOrder != null ? Number(flowPayment.flowOrder) : null;
  if (flowOrder != null && !Number.isNaN(flowOrder)) {
    const existing = await prisma.paymentReceipt.findUnique({
      where: { flowOrder },
    });
    if (existing) return existing;
  }

  const organization = await prisma.restaurantOrganization.findUnique({
    where: { id: organizationId },
    include: { plan: true, owner: { select: { email: true, name: true, lastName: true } } },
  });
  if (!organization) throw new Error(`Organization ${organizationId} not found`);

  const subscription = await prisma.subscription.findFirst({
    where: {
      organizationId,
      status: { in: ['active', 'grace', 'cancelled'] },
    },
    orderBy: { startDate: 'desc' },
  });

  const planId = subscription?.planId ?? organization.planId;
  const plan = planId
    ? await prisma.plan.findUnique({ where: { id: planId } })
    : null;
  if (!plan) throw new Error(`Plan not found for org ${organizationId}`);

  const amount = Number(flowPayment?.paymentData?.amount ?? flowPayment?.amount ?? 0);
  const currency = flowPayment?.paymentData?.currency || flowPayment?.currency || 'CLP';
  const paymentDate = flowPayment?.paymentData?.date
    ? new Date(flowPayment.paymentData.date)
    : new Date();
  const ownerName = [organization.owner?.name, organization.owner?.lastName].filter(Boolean).join(' ').trim();

  const receipt = await prisma.paymentReceipt.create({
    data: {
      organizationId,
      subscriptionId: subscription?.id ?? null,
      planId: plan.id,
      amount,
      currency,
      paymentDate,
      receiptType: organization.billingType || 'boleta',
      clientName: organization.billingBusinessName || ownerName || organization.owner?.email || null,
      clientEmail: organization.billingEmail || organization.owner?.email || null,
      clientTaxId: organization.billingTaxId,
      clientBusinessName: organization.billingBusinessName,
      clientAddress: organization.billingAddress,
      provider: 'flow',
      flowOrder: flowOrder != null && !Number.isNaN(flowOrder) ? flowOrder : null,
      flowInvoiceId: extras.flowInvoiceId || null,
      mercadopagoStatus: 'approved',
    },
    include: { plan: true, organization: true },
  });

  try {
    const { generateReceiptPdf } = require('./billing/receiptPdfGenerator');
    const { sendPaymentApprovedEmail } = require('./billing/billingTransactionalEmailService');
    const pdfBuffer = await generateReceiptPdf(receipt, receipt.organization, receipt.plan);
    await sendPaymentApprovedEmail({
      organizationId,
      planName: plan.name,
      amountCLP: Number(amount),
      currency,
      pdfBuffer,
    });
  } catch (emailErr) {
    console.warn('[PaymentReceipt] Flow payment approved email error:', emailErr?.message);
  }

  return receipt;
}

/**
 * Marks a legal receipt as sent.
 */
async function markLegalReceiptSent(receiptId, adminUserId) {
  return await prisma.paymentReceipt.update({
    where: { id: receiptId },
    data: {
      legalReceiptSent: true,
      legalReceiptSentAt: new Date(),
      legalReceiptSentBy: adminUserId,
    },
  });
}

/**
 * Marks a legal receipt as unsent.
 */
async function markLegalReceiptUnsent(receiptId) {
  return await prisma.paymentReceipt.update({
    where: { id: receiptId },
    data: {
      legalReceiptSent: false,
      legalReceiptSentAt: null,
      legalReceiptSentBy: null,
    },
  });
}

/**
 * Lists receipts with filters and pagination.
 */
async function listReceipts(filters = {}, pagination = {}) {
  const { page, limit, skip } = parsePagination(pagination);
  const { organizationId, receiptType, legalReceiptSent, dateFrom, dateTo } = filters;

  const where = {};
  if (organizationId) where.organizationId = organizationId;
  if (receiptType) where.receiptType = receiptType;
  if (legalReceiptSent !== undefined) where.legalReceiptSent = legalReceiptSent === 'true' || legalReceiptSent === true;
  
  if (dateFrom || dateTo) {
    where.paymentDate = {};
    if (dateFrom) where.paymentDate.gte = new Date(dateFrom);
    if (dateTo) where.paymentDate.lte = new Date(dateTo);
  }

  const [receipts, total] = await Promise.all([
    prisma.paymentReceipt.findMany({
      where,
      skip,
      take: limit,
      orderBy: { paymentDate: 'desc' },
      include: {
        organization: { select: { name: true } },
        plan: { select: { name: true, productSKU: true } },
      },
    }),
    prisma.paymentReceipt.count({ where }),
  ]);

  return paginatedResponse(receipts, total, page, limit);
}

module.exports = {
  createReceiptFromMPPayment,
  createReceiptFromFlowPayment,
  markLegalReceiptSent,
  markLegalReceiptUnsent,
  listReceipts,
};
