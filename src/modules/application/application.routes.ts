import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/authorize.middleware";
import {
  UPLOAD_FOLDER_MAP,
  ensureDirectoryExists,
} from "../../utils/fileStorage";
import { sendError } from "../../utils/response";
import {
  createApplication,
  getApplicationById,
  getApplicationByReference,
  listApplications,
  adminListApplications,
  adminGetApplication,
  adminSetUnderReview,
  adminApproveApplication,
  adminDeclineApplication,
} from "./application.controller";
import { getActiveServiceByCode } from "../services/service.service";

const router = Router();

// Configure multer storage
const diskStorage = multer.diskStorage({
  destination: (req: Request, file: Express.Multer.File, cb) => {
    const targetFolder = UPLOAD_FOLDER_MAP.documents;
    ensureDirectoryExists(targetFolder);
    cb(null, targetFolder);
  },
  filename: (req: Request, file: Express.Multer.File, cb) => {
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const ext = path.extname(file.originalname);
    cb(null, `doc-${uniqueSuffix}${ext}`);
  },
});

// Helper function to determine actual MIME type from file extension
function getActualMimeType(filename: string, detectedMimeType: string): string {
  // If it's already a known type, return it
  const knownTypes = [
    "image/jpeg",
    "image/png",
    "application/pdf",
    "image/jpg",
  ];
  if (knownTypes.includes(detectedMimeType)) {
    return detectedMimeType;
  }

  // If it's application/octet-stream, determine from extension
  if (detectedMimeType === "application/octet-stream") {
    const ext = path.extname(filename).toLowerCase();
    const mimeMap: { [key: string]: string } = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".pdf": "application/pdf",
    };
    return mimeMap[ext] || detectedMimeType;
  }

  return detectedMimeType;
}

// Configure multer with file filter
const upload = multer({
  storage: diskStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (
    req: Request,
    file: Express.Multer.File,
    cb: multer.FileFilterCallback,
  ) => {
    const actualMimeType = getActualMimeType(file.originalname, file.mimetype);
    const allowedMimeTypes = [
      "image/jpeg",
      "image/png",
      "application/pdf",
      "image/jpg",
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExtensions = [".jpg", ".jpeg", ".png", ".pdf"];

    if (
      allowedMimeTypes.includes(actualMimeType) ||
      allowedExtensions.includes(ext)
    ) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  },
});

// Upload handler
const uploadHandler = (req: Request, res: Response, next: NextFunction) => {
  upload.any()(req, res, (err: any) => {
    if (err) {
      console.error("Upload error:", err);

      if (err.code === "LIMIT_FILE_SIZE") {
        return sendError(
          res,
          "File size exceeds the 5MB limit.",
          "BAD_REQUEST",
          null,
          400,
        );
      }

      return sendError(
        res,
        `File upload failed: ${err.message}`,
        "BAD_REQUEST",
        null,
        400,
      );
    }

    // Fix MIME types for files that came as application/octet-stream
    const files = (req as any).files || [];
    files.forEach((file: any) => {
      if (file.mimetype === "application/octet-stream") {
        const ext = path.extname(file.originalname).toLowerCase();
        const mimeMap: { [key: string]: string } = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".pdf": "application/pdf",
        };
        file.mimetype = mimeMap[ext] || file.mimetype;
      }
    });

    // console.log('Files received (with corrected MIME types):', files);
    // console.log('Body received:', req.body);

    console.log("========== MULTER UPLOAD DEBUG ==========");

    console.log("Content-Type:", req.headers["content-type"]);

    console.log("Body:", req.body);

    console.log(
      "Files:",
      ((req as any).files || []).map((file: any) => ({
        fieldname: file.fieldname,
        originalname: file.originalname,
        filename: file.filename,
        mimetype: file.mimetype,
        size: file.size,
        path: file.path,
      })),
    );

    console.log("=========================================");

    next();
  });
};

// Validate document types in the controller or middleware
const validateDocumentTypes = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const files = (req as any).files || [];
  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "application/pdf",
    "image/jpg",
  ];

  // Check if all files have valid types
  for (const file of files) {
    const isValid = allowedTypes.includes(file.mimetype);
    if (!isValid) {
      return sendError(
        res,
        `Invalid file type for "${file.fieldname}". Only JPG, PNG, and PDF are allowed.`,
        "VALIDATION_ERROR",
        null,
        400,
      );
    }
  }

  next();
};

// Your existing validation for document types per service
const checkServiceDocumentTypes = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // This is where you check if the uploaded document types match what the service requires
  // You'll need to implement this based on your service configuration

  const files = (req as any).files || [];
  const uploadedFields = files.map((f: any) => f.fieldname);

  // Example: Check if the service requires these document types
  // You'll need to fetch the service from DB and check its required documents

  // For now, just log and pass through

  // If you have a service config that specifies allowed document types:
  const serviceId = req.body.serviceId;
  const service = await getActiveServiceByCode(serviceId);
  // console.log('Uploaded document fields:',service);
  const allowedDocumentTypes = service.requirements || [];
  const invalidTypes = uploadedFields.filter(
    (f) => !allowedDocumentTypes.includes(f),
  );
  if (invalidTypes.length > 0) {
    return sendError(
      res,
      `Invalid document types for this service: ${invalidTypes.join(", ")}`,
      "VALIDATION_ERROR",
      null,
      400,
    );
  }

  next();
};

// Apply middlewares in order
router.post(
  "/",
  requireAuth,
  uploadHandler,
  validateDocumentTypes,
  checkServiceDocumentTypes,
  createApplication,
);

router.patch(
  "/:id/complete",
  requireAuth,
  uploadHandler,
  validateDocumentTypes,
  checkServiceDocumentTypes,
  createApplication,
);

// Admin (LGA) endpoints
router.get(
  "/admin",
  requireAuth,
  requireRole("lga_admin", "super_admin"),
  adminListApplications,
);
router.get(
  "/admin/:id",
  requireAuth,
  requireRole("lga_admin", "super_admin"),
  adminGetApplication,
);
router.patch(
  "/admin/:id/under-review",
  requireAuth,
  requireRole("lga_admin", "super_admin"),
  adminSetUnderReview,
);
router.patch(
  "/admin/:id/approve",
  requireAuth,
  requireRole("lga_admin", "super_admin"),
  adminApproveApplication,
);
router.patch(
  "/admin/:id/decline",
  requireAuth,
  requireRole("lga_admin", "super_admin"),
  adminDeclineApplication,
);

// Public "Track My Application" lookup — intentionally NOT behind requireAuth:
// citizens track by application number without an account. The handler returns
// a redacted projection (name-only applicant, no contact details / gateway refs).
// Registered before "/:id" so "reference" can never be swallowed as an id.
router.get("/reference/:reference", getApplicationByReference);

router.get("/:id", requireAuth, getApplicationById);
router.get("/", requireAuth, listApplications);

export default router;
