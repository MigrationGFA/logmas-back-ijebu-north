// offline.routes.ts
//
// Field officer offline sync. Unlike the first version of this module,
// every route is authenticated and restricted to field officers: a sync
// creates real applications and carries citizen personal data.
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/authorize.middleware";
import { validateBody } from "../../middleware/validate.middleware";
import { syncOfflineRecordSchema } from "./offline.validation";
import {
  syncOfflineForm,
  getOfflineSyncStatus,
  listMySyncs,
  retrySync,
} from "./offline.controller";

const router = Router();
const guard = [requireAuth, requireRole("field_officer")];

router.post("/sync", ...guard, validateBody(syncOfflineRecordSchema), syncOfflineForm);
router.get("/mine", ...guard, listMySyncs);
router.get("/status/:id", ...guard, getOfflineSyncStatus);
router.post("/:id/retry", ...guard, retrySync);

export default router;
