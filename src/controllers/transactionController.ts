import { Response } from 'express';
import { supabase } from '../lib/supabase';
import { sendSuccess, sendError } from '../utils/response';
import { AuthRequest } from '../middleware/auth';

// Personal data is owned by the individual user (user_id). Business data is
// shared across every login that belongs to the same company (company_id) —
// that's the whole point of inviting teammates in. This helper applies the
// correct scope everywhere so it's never accidentally missed on one query.
//
// SupabaseQueryBuilder type is intentionally loose here (the exact generic
// signature varies by query shape); functionally this just adds one .eq().
function scopeToAccount(query: any, user: { id: string; mode: string; company_id?: string | null }) {
  if (user.mode === 'business') {
    if (!user.company_id) {
      // A business account that somehow has no company yet (shouldn't
      // normally happen) — scope to something that matches nothing rather
      // than accidentally falling back to a personal-style user_id scope.
      return query.eq('company_id', '00000000-0000-0000-0000-000000000000');
    }
    return query.eq('company_id', user.company_id);
  }
  return query.eq('user_id', user.id);
}

// GET /api/transactions
export const getTransactions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { type, category, startDate, endDate, limit = 50, page = 1 } = req.query;
    const mode = req.user!.mode; // always the account's real mode — client value ignored
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .order('date', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    query = scopeToAccount(query, req.user!);
    query = query.eq('mode', mode);
    if (type)      query = query.eq('type', type);
    if (category)  query = query.eq('category', category);
    if (startDate) query = query.gte('date', startDate as string);
    if (endDate)   query = query.lte('date', endDate as string);

    const { data, error, count } = await query;
    if (error) { sendError(res, error.message, 500); return; }

    sendSuccess(res, {
      transactions: data || [],
      total: count || 0,
      page: Number(page),
      pages: Math.ceil((count || 0) / Number(limit)),
    });
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// POST /api/transactions
export const createTransaction = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { type, amount, category, description, date, tags } = req.body;
    const mode = req.user!.mode; // a transaction always belongs to the account's own mode

    const { data: tx, error } = await supabase
      .from('transactions')
      .insert({
        user_id: req.user!.id, // who actually added it, for audit purposes
        company_id: mode === 'business' ? req.user!.company_id : null, // who it's shared with
        type, amount: Number(amount), category, description,
        date: date || new Date().toISOString().split('T')[0], mode, tags,
      })
      .select()
      .single();

    if (error) { sendError(res, error.message, 500); return; }

    // Budget `spent` amounts are recalculated automatically from real
    // transactions whenever the Budgets page is opened (see budgetController
    // → recalcSpent) — no separate update needed here.

    sendSuccess(res, tx, 'Transaction created', 201);
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// PUT /api/transactions/:id
export const updateTransaction = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Never let the update body overwrite ownership/scoping fields — those
    // are set once at creation time and must not be changeable via a
    // generic edit (that would let someone move a transaction into another
    // company's data, or detach it from their own).
    const { user_id, company_id, mode, ...safeUpdates } = req.body;

    let query = supabase.from('transactions').update(safeUpdates).eq('id', req.params.id);
    query = scopeToAccount(query, req.user!);
    const { data: tx, error } = await query.select().single();
    if (error || !tx) { sendError(res, 'Transaction not found', 404); return; }
    sendSuccess(res, tx);
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// DELETE /api/transactions/:id
// Note: for business accounts this deletes by company scope, not just the
// original creator — any teammate can delete any shared transaction, by
// design (equal access within a company, no admin/member roles).
export const deleteTransaction = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let query = supabase.from('transactions').delete().eq('id', req.params.id);
    query = scopeToAccount(query, req.user!);
    const { error } = await query;
    if (error) { sendError(res, 'Transaction not found', 404); return; }
    sendSuccess(res, null, 'Transaction deleted');
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// GET /api/transactions/summary
// Defaults to the most recent 30 days of *actual data* rather than rigidly
// "this calendar month" — a historical CSV import (e.g. data from several
// months ago) would otherwise always summarize to zero, since the current
// calendar month would have no rows at all. An explicit month/year query
// param still works exactly as before for anyone who wants a specific month.
export const getSummary = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const mode = req.user!.mode;
    const { month, year } = req.query;

    let start: string;
    let end: string;

    if (month || year) {
      const now = new Date();
      const m = Number(month) || now.getMonth() + 1;
      const y = Number(year) || now.getFullYear();
      start = `${y}-${String(m).padStart(2,'0')}-01`;
      end   = new Date(y, m, 0).toISOString().split('T')[0];
    } else {
      // Find the most recent transaction date for this account, then show
      // the 30 days ending there. Falls back to "today" if there's no data.
      let latestQuery = supabase.from('transactions').select('date').eq('mode', mode);
      latestQuery = scopeToAccount(latestQuery, req.user!);
      const { data: latest } = await latestQuery.order('date', { ascending: false }).limit(1).single();

      const endDate = latest ? new Date(latest.date) : new Date();
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 29);

      start = startDate.toISOString().split('T')[0];
      end = endDate.toISOString().split('T')[0];
    }

    let query = supabase.from('transactions').select('type, amount').eq('mode', mode).gte('date', start).lte('date', end);
    query = scopeToAccount(query, req.user!);

    const { data, error } = await query;
    if (error) { sendError(res, error.message, 500); return; }

    const totalIncome  = (data||[]).filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0);
    const totalExpense = (data||[]).filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);
    const savings      = totalIncome - totalExpense;
    const savingsRate  = totalIncome > 0 ? (savings / totalIncome) * 100 : 0;

    sendSuccess(res, { totalIncome, totalExpense, savings, savingsRate });
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// GET /api/transactions/monthly
export const getMonthly = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const mode = req.user!.mode;
    const { months = 6 } = req.query;
    const since = new Date();
    since.setMonth(since.getMonth() - Number(months) + 1);
    since.setDate(1);

    let query = supabase.from('transactions').select('type, amount, date').eq('mode', mode).gte('date', since.toISOString().split('T')[0]);
    query = scopeToAccount(query, req.user!);

    const { data, error } = await query;
    if (error) { sendError(res, error.message, 500); return; }

    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const map: Record<string, { income: number; expense: number }> = {};

    (data || []).forEach(t => {
      const d = new Date(t.date);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (!map[key]) map[key] = { income: 0, expense: 0 };
      map[key][t.type as 'income'|'expense'] += Number(t.amount);
    });

    const result = Object.entries(map)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([key, v]) => {
        const month = Number(key.split('-')[1]);
        return { month: MONTH_NAMES[month-1], income: v.income, expense: v.expense, savings: v.income - v.expense };
      });

    sendSuccess(res, result);
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// GET /api/transactions/by-category
// Same windowing fix as getSummary: defaults to the 30 days ending at the
// most recent transaction date, not rigidly "this calendar month" — so a
// historical CSV import still populates the Dashboard's category chart.
export const getByCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const mode = req.user!.mode;
    const { type = 'expense', month, year } = req.query;

    let start: string;
    let end: string;

    if (month || year) {
      const now = new Date();
      const m = Number(month) || now.getMonth() + 1;
      const y = Number(year) || now.getFullYear();
      start = `${y}-${String(m).padStart(2,'0')}-01`;
      end   = new Date(y, m, 0).toISOString().split('T')[0];
    } else {
      let latestQuery = supabase.from('transactions').select('date').eq('mode', mode);
      latestQuery = scopeToAccount(latestQuery, req.user!);
      const { data: latest } = await latestQuery.order('date', { ascending: false }).limit(1).single();

      const endDate = latest ? new Date(latest.date) : new Date();
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 29);

      start = startDate.toISOString().split('T')[0];
      end = endDate.toISOString().split('T')[0];
    }

    let query = supabase.from('transactions').select('category, amount').eq('type', type).eq('mode', mode).gte('date', start).lte('date', end);
    query = scopeToAccount(query, req.user!);

    const { data, error } = await query;
    if (error) { sendError(res, error.message, 500); return; }

    const COLORS = ['#10b981','#3b82f6','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16'];
    const catMap: Record<string, number> = {};
    (data||[]).forEach(t => { catMap[t.category] = (catMap[t.category]||0) + Number(t.amount); });
    const total = Object.values(catMap).reduce((s,v) => s+v, 0);

    const result = Object.entries(catMap)
      .sort(([,a],[,b]) => b-a)
      .map(([category, amount], i) => ({
        category, amount,
        percentage: total > 0 ? Math.round((amount/total)*100) : 0,
        color: COLORS[i % COLORS.length],
      }));

    sendSuccess(res, result);
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// GET /api/transactions/categories
// Returns the distinct categories that actually exist in this account's own
// (or company's shared) transactions — used to populate the budget category
// dropdown so it reflects real imported/entered data instead of a generic
// hardcoded list. Expense and income categories are returned separately
// since budgets are normally set against expense categories.
export const getCategoryList = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const mode = req.user!.mode;

    let query = supabase.from('transactions').select('category, type').eq('mode', mode);
    query = scopeToAccount(query, req.user!);

    const { data, error } = await query;
    if (error) { sendError(res, error.message, 500); return; }

    const expenseCats = Array.from(new Set((data || []).filter(t => t.type === 'expense').map(t => t.category))).sort();
    const incomeCats  = Array.from(new Set((data || []).filter(t => t.type === 'income').map(t => t.category))).sort();

    sendSuccess(res, { expense: expenseCats, income: incomeCats });
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};
