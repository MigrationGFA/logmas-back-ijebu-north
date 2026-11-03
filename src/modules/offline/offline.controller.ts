// offline.controller.ts
//
// HTTP layer for field officer offline sync. All business logic lives in
// offline.service.ts. Every route sits behind requireAuth and the
// field_officer role guard (see offline.routes.ts): a sync record carries a
// citizen's personal data and creates real applications, so there is no
// public access here.
import { Request, Response, NextFunction } from "express";
import { sendSuccess, sendError } from "../../utils/response";
import {
  syncOfflineRecord,
  getSyncStatus,
  listMySyncRecords,
  markForRetry,
  SyncError,
} from "./offline.service";

function handleSyncError(err: unknown, next: NextFunction, res: Response) {
  if (err instanceof SyncError) {
    return sendError(res, err.message, err.code, null, err.statusCode);
  }
  return next(err);
}

/** POST /api/v1/offline/sync: create the real record from a captured one. */
export const syncOfflineForm = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const officer = req.user!;
    const { ledger, result } = await syncOfflineRecord(
      { id: officer.id, email: officer.email, role: officer.role },
      req.body,
    );
    return sendSuccess(
      res,
      { sync: ledger, result },
      "Offline record synced",
      201,
    );
  } catch (err) {
    return handleSyncError(err, next, res);
  }
};

/** GET /api/v1/offline/mine: the signed in officer's sync history. */
export const listMySyncs = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const officer = req.user!;
    const limit = Number(req.query.limit ?? 100);
    const records = await listMySyncRecords(
      { id: officer.id, email: officer.email, role: officer.role },
      Number.isFinite(limit) ? limit : 100,
    );
    return sendSuccess(res, records);
  } catch (err) {
    return handleSyncError(err, next, res);
  }
};

/** GET /api/v1/offline/status/:id: one record, by ledger id or clientRecordId. */
export const getOfflineSyncStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const officer = req.user!;
    const ledger = await getSyncStatus(
      { id: officer.id, email: officer.email, role: officer.role },
      String(req.params.id),
    );
    return sendSuccess(res, ledger);
  } catch (err) {
    return handleSyncError(err, next, res);
  }
};

/** POST /api/v1/offline/:id/retry: hand the record back to the device queue. */
export const retrySync = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const officer = req.user!;
    const ledger = await markForRetry(
      { id: officer.id, email: officer.email, role: officer.role },
      String(req.params.id),
    );
    return sendSuccess(
      res,
      ledger,
      "Record returned to the device queue for resending",
      200,
    );
  } catch (err) {
    return handleSyncError(err, next, res);
  }
};
