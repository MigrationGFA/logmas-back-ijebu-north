// offline.routes.ts
import { Router } from 'express';
import { syncOfflineForm, getOfflineSyncStatus, retrySync } from './offline.controller';

const router = Router();

router.post('/sync', syncOfflineForm);
router.get('/status/:id', getOfflineSyncStatus);
router.post('/:id/retry', retrySync);

export default router;