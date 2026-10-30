// offline.controller.ts
import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../utils/prisma';
import { sendSuccess, sendError } from '../../utils/response';

export const syncOfflineForm = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { applicationId, formType, formData, source } = req.body;

    if (!applicationId || !formType || !formData) {
      return sendError(res, 'applicationId, formType, and formData are required', 'VALIDATION_ERROR', null, 400);
    }

    const offlineSync = await prisma.offlineSync.create({
      data: {
        applicationId,
        formType,
        formData,
        source: source || 'web',
        status: 'pending',
      },
    });

    return sendSuccess(res, offlineSync, 'Offline form sync queue created', 201);
  } catch (err) {
    next(err);
  }
};

export const getOfflineSyncStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const offlineSync = await prisma.offlineSync.findUnique({
      where: { id },
      include: { application: true },
    });

    if (!offlineSync) {
      return sendError(res, 'Offline sync record not found', 'NOT_FOUND', null, 404);
    }

    return sendSuccess(res, offlineSync);
  } catch (err) {
    next(err);
  }
};

export const retrySync = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const offlineSync = await prisma.offlineSync.update({
      where: { id },
      data: { status: 'pending', syncedAt: null },
    });

    return sendSuccess(res, offlineSync, 'Offline sync record queued for retry');
  } catch (err) {
    next(err);
  }
};