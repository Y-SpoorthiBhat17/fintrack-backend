import { Router } from 'express';
import { getInsights } from '../controllers/aiController';
import { protect } from '../middleware/auth';

const router = Router();

router.use(protect);
router.get('/insights', getInsights);

export default router;
