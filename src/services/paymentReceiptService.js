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
  return await prisma.paymentReceipt.create({
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
  });
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
  markLegalReceiptSent,
  markLegalReceiptUnsent,
  listReceipts,
};
