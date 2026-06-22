import { Router } from 'express';
import { importFromCSV } from '../controllers/importController';
import { protect } from '../middleware/auth';

const router = Router();
router.use(protect);

router.post('/csv', importFromCSV);

export default router;
