import { Router } from 'express';
import { getBudgets, createBudget, updateBudget, deleteBudget, syncBudgetSpent } from '../controllers/budgetController';
import { protect } from '../middleware/auth';

const router = Router();
router.use(protect);

router.get('/', getBudgets);
router.post('/', createBudget);
router.post('/sync', syncBudgetSpent);
router.put('/:id', updateBudget);
router.delete('/:id', deleteBudget);

export default router;
