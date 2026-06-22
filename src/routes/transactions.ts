import { Router } from 'express';
import {
  getTransactions, createTransaction, updateTransaction,
  deleteTransaction, getSummary, getMonthly, getByCategory, getCategoryList,
} from '../controllers/transactionController';
import { protect } from '../middleware/auth';

const router = Router();
router.use(protect);

// ⚠️ Static routes MUST come before /:id routes
router.get('/summary', getSummary);
router.get('/monthly', getMonthly);
router.get('/by-category', getByCategory);
router.get('/categories', getCategoryList);

router.get('/', getTransactions);
router.post('/', createTransaction);
router.put('/:id', updateTransaction);
router.delete('/:id', deleteTransaction);

export default router;
