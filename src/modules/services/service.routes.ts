import { Router } from "express";
import {
  createServiceController,
  deleteServiceController,
  getServiceByCode,
  listServices,
  updateServiceController,
} from "./services.controller";
import { createFoCollection } from "./foCollection.controller";
import { requireAuth } from "../../middleware/auth.middleware";

const router = Router();

// Public service catalogue
router.post("/", requireAuth, createServiceController);
router.get("/", listServices);
router.patch("/:id", requireAuth, updateServiceController);
router.delete("/:id", requireAuth, deleteServiceController);

// Field-officer collection for FO-only services (application + invoice)
router.post("/fo-collections", requireAuth, createFoCollection);

// Single service
router.get("/:code", getServiceByCode);

export default router;
