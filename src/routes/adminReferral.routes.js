const express = require('express');
const prisma = require('../lib/prisma');
const { parsePagination, paginatedResponse } = require('../utils/pagination');
const { NotFoundError, ValidationError } = require('../utils/errors');
const referralService = require('../services/referralService');

const router = express.Router();

const referralInclude = {
  referrerOrganization: {
    include: {
      owner: { select: { id: true, email: true, name: true, lastName: true } },
      plan: { select: { id: true, name: true, productSKU: true } },
      subscriptions: {
        where: { isActiveSubscription: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { plan: true },
      },
    },
  },
  refereeOrganization: {
    include: {
      owner: { select: { id: true, email: true, name: true, lastName: true } },
      plan: { select: { id: true, name: true, productSKU: true } },
      subscriptions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { plan: true },
      },
      paymentReceipts: { orderBy: { paymentDate: 'desc' }, take: 10, include: { plan: true } },
    },
  },
  rewardCredit: true,
};

router.get('/', async (req, res, next) => {
  try {
    const { status, referrerOrgId, refereeOrgId, search } = req.query;
    const { page, limit, skip } = parsePagination(req.query);

    const where = {};
    if (status) where.status = status;
    if (referrerOrgId) where.referrerOrganizationId = referrerOrgId;
    if (refereeOrgId) where.refereeOrganizationId = refereeOrgId;
    if (search && String(search).trim()) {
      const q = String(search).trim();
      where.OR = [
        { refereeEmail: { contains: q, mode: 'insensitive' } },
        { referrerOrganizationId: q },
        { refereeOrganizationId: q },
        { referrerOrganization: { name: { contains: q, mode: 'insensitive' } } },
        { refereeOrganization: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.referral.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          referrerOrganization: { select: { id: true, name: true } },
          refereeOrganization: { select: { id: true, name: true } },
          rewardCredit: { select: { id: true, amountDays: true, status: true } },
        },
      }),
      prisma.referral.count({ where }),
    ]);

    res.json(paginatedResponse(rows, total, page, limit));
  } catch (error) {
    next(error);
  }
});

router.get('/credits/list', async (req, res, next) => {
  try {
    const { organizationId, status } = req.query;
    const { page, limit, skip } = parsePagination(req.query);
    const where = {};
    if (organizationId) where.organizationId = organizationId;
    if (status) where.status = status;

    const [rows, total] = await Promise.all([
      prisma.referralCredit.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          organization: { select: { id: true, name: true } },
          sourceReferral: {
            select: {
              id: true,
              refereeOrganization: { select: { name: true } },
            },
          },
        },
      }),
      prisma.referralCredit.count({ where }),
    ]);

    res.json(paginatedResponse(rows, total, page, limit));
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const referral = await prisma.referral.findUnique({
      where: { id: req.params.id },
      include: referralInclude,
    });
    if (!referral) throw new NotFoundError('Referido no encontrado');
    res.json(referral);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/approve', async (req, res, next) => {
  try {
    const { amountDays, notes } = req.body || {};
    const result = await referralService.approveReferral(req.params.id, req.user.id, {
      amountDays,
      notes,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/reject', async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    const referral = await referralService.rejectReferral(req.params.id, req.user.id, reason);
    res.json(referral);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/mark-fraud', async (req, res, next) => {
  try {
    const { note } = req.body || {};
    const referral = await referralService.markAsFraud(req.params.id, req.user.id, note);
    res.json(referral);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/revoke-reward', async (req, res, next) => {
  try {
    const referral = await referralService.revokeReward(req.params.id, req.user.id);
    res.json(referral);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/notes', async (req, res, next) => {
  try {
    const { internalNotes } = req.body || {};
    const referral = await prisma.referral.update({
      where: { id: req.params.id },
      data: { internalNotes: internalNotes ?? null },
    });
    res.json(referral);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
