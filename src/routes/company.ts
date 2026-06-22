import { Router } from 'express';
import { getMyCompany } from '../controllers/companyController';
import { protect } from '../middleware/auth';

const router = Router();
router.use(protect);

router.get('/me', getMyCompany);

export default router;
