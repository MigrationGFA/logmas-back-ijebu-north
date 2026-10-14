import path from 'path';
import fs from 'fs';

// Define a strict whitelist of allowed upload categories to protect your cPanel directory structure
export const UPLOAD_FOLDER_MAP: Record<string, string> = {
  passports: 'public/uploads/passports',
  complaints: 'public/uploads/complaints',
  permits: 'public/uploads/permits',
  news: 'public/uploads/news',
  documents: 'public/uploads/documents',
  paymentProofs: 'public/uploads/payment-proofs'
};

/**
 * Ensures that the target directory exists on the cPanel disk.
 * If it doesn't, it recursively creates it.
 */
export const ensureDirectoryExists = (folderPath: string): void => {
  const resolvedPath = path.resolve(folderPath);
  if (!fs.existsSync(resolvedPath)) {
    fs.mkdirSync(resolvedPath, { recursive: true });
  }
};