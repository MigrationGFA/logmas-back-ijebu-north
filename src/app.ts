import compression from 'compression';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';

import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/user/users.routes';
import notificationsRoutes from './modules/notification/notification.routes';
import wardRoutes from './modules/ward/wards.routes';
import complaintRoutes from './modules/complaints/complaints.routes';
import fieldOperationsRoutes from './modules/operations/field.routes';
import uploadRoutes from './modules/uploads/upload.routes';
import lgaRoutes from './modules/lgaAdmin/lgaAdmin.routes';
import reportRoutes from './modules/report/report.routes';
import auditorRoutes   from './modules/auditor/auditor.routes';
import chairmanRoutes   from './modules/chairman/chairman.routes';
import offlineRoutes from './modules/offline/offline.routes';
import treasurerRoutes from './modules/treasurer/treasurer.routes';
import demandNoticeRoutes from './modules/demandNotice/demandNotice.routes';
import gernralRoutes from './modules/general/general.routes';
import invoiceRoutes from './modules/invoice/invoice.routes';
import applicationRoutes from './modules/application/application.routes';
import receiptRoutes from './modules/receipts/receipt.routes';
import certificateRoutes from './modules/certificate/certificate.routes';
import dashboardRoutes from './modules/dashboard/dashboard.controller';
import serviceRoutes from "./modules/services/service.routes";
import newsRoutes from './modules/news/news.routes';

import { errorHandler } from './middleware/error.middleware';
import { swaggerDocument } from './config/swagger';
import paymentRoutes from './modules/payment/payment.routes';
import gpayRoutes from './modules/payment/gpay.routes';
import rateLimit from 'express-rate-limit';


const app = express();

app.disable('etag');
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  }));
app.use(cors());
app.use(morgan('dev'));
// app.use(express.json());

// 1. Global Limiter: General protection for all API routes (e.g., 100 requests per 15 mins)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  message: {
    status: "error",
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests from this IP, please try again after 15 minutes.",
      details: null,
    },
  },
});


// Apply global rate limiting to all requests
app.use(globalLimiter);

// Base Health-Check Endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    status: "healthy",
    system: "LOGMAS API Engine",
    version: "1.0.0-phase1",
    timestamp: new Date().toISOString()
  });
});

app.use('/public', express.static('public', { maxAge: '7d', etag: true }));
app.use("/api/v1/payments", paymentRoutes); // must come before express.json() below
app.use("/api/v1/payments/gpay", gpayRoutes); // also before express.json() — GPay signs the raw webhook body
app.use(compression());
app.use(express.json());


// API Engine Base Routing Architecture
// app.use('/api/v1/auth', authRoutes);
app.use("/api/v1/services", serviceRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/wards', wardRoutes);
app.use('/api/v1/lga', lgaRoutes);
app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/treasurer', treasurerRoutes);
app.use('/api/v1/auditor',   auditorRoutes);
app.use('/api/v1/complaints', complaintRoutes);
app.use('/api/v1/general', gernralRoutes);
app.use('/api/v1/invoices', invoiceRoutes);
app.use('/api/v1/applications', applicationRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/field-officer', fieldOperationsRoutes);
app.use('/api/v1/uploads', uploadRoutes);
app.use('/api/v1/receipts', receiptRoutes);
app.use('/api/v1/certificates', certificateRoutes);
app.use('/api/v1/chairman',    chairmanRoutes);
app.use('/api/v1/offline',   offlineRoutes);
app.use('/api/v1/demand-notices', demandNoticeRoutes);
app.use('/api/v1', newsRoutes); // News & Updates: /news* (public) + /lga/news* (chairman, lga_admin)


// Shared Interactive Engine Schema Verification Explorer Links UI Routes
// app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Catch-All Global Pipeline Middleware Interceptors Engine Layer Handler
app.use(errorHandler);

export default app;