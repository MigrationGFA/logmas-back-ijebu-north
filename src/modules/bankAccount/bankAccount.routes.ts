import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { getBankAccount, upsertBankAccount } from "./bankAccount.controller";

const router = Router();

router.get("/", requireAuth, getBankAccount);
router.put("/", requireAuth, upsertBankAccount);

export default router;
