// src/middleware/rateLimiters.ts
import rateLimit from 'express-rate-limit';

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests from this IP, please try again after 15 minutes.",
      details: null,
    },
  },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Too many authentication attempts. Please wait 15 minutes before trying again.",
      details: null,
    },
  },
});

// Dedicated limiter for resend-verification: 2 requests per hour per IP
export const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 2,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "You can only request 2 verification emails per hour. Please wait before trying again.",
      details: null,
    },
  },
});