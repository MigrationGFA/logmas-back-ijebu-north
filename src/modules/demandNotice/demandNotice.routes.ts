import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import {
  createDemandNotice,
  listDemandNotices,
  getDemandNoticeByRef,
  cancelDemandNotice,
  resendDemandNotice,
} from "./demandNotice.controller";

const router = Router();

// Public / Payer lookup of a single notice by reference or application number
router.get("/:reference", getDemandNoticeByRef);

// Authenticated Officer & Admin operations
router.use(requireAuth);

router.post("/", createDemandNotice);
router.get("/", listDemandNotices);
router.post("/:id/cancel", cancelDemandNotice);
router.post("/:id/resend", resendDemandNotice);

export default router;
