import { Response } from 'express';
import { supabase } from '../lib/supabase';
import { sendSuccess, sendError } from '../utils/response';
import { AuthRequest } from '../middleware/auth';

type Account = { id: string; mode: string; company_id?: string | null };

// Personal budgets are owned by the individual user. Business budgets are
// shared across the whole company — any teammate sees and can edit the same
// budget, since access is equal with no admin/member distinction.
function scopeToAccount(query: any, user: Account) {
  if (user.mode === 'business') {
    if (!user.company_id) return query.eq('company_id', '00000000-0000-0000-0000-000000000000');
    return query.eq('company_id', user.company_id);
  }
  return query.eq('user_id', user.id);
}

// Recalculate every budget's `spent` from real transactions — always called
// automatically, never needs a button.
async function recalcSpent(account: Account, m: number, y: number) {
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(y, m, 0).toISOString().split('T')[0];

  let bQuery = supabase.from('budgets').select('*').eq('month', m).eq('year', y).eq('mode', account.mode);
  bQuery = scopeToAccount(bQuery, account);
  const { data: budgets } = await bQuery;
  if (!budgets || budgets.length === 0) return;

  await Promise.all(budgets.map(async (b) => {
    let txQuery = supabase
      .from('transactions')
      .select('amount')
      .eq('type', 'expense')
      .eq('category', b.category)
      .eq('mode', b.mode)
      .gte('date', start)
      .lte('date', end);
    txQuery = scopeToAccount(txQuery, account);

    const { data: txs } = await txQuery;
    const realSpent = (txs || []).reduce((s, t) => s + Number(t.amount), 0);
    if (realSpent !== b.spent) {
      await supabase.from('budgets').update({ spent: realSpent }).eq('id', b.id);
    }
  }));
}

// GET /api/budgets
export const getBudgets = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const account = req.user!;
    const mode = account.mode; // always the account's real mode
    const { month, year } = req.query;
    const now = new Date();
    const m = Number(month) || now.getMonth() + 1;
    const y = Number(year) || now.getFullYear();

    // Auto-sync spent amounts from transactions before returning —
    // always accurate, no manual sync button needed.
    await recalcSpent(account, m, y);

    let query = supabase.from('budgets').select('*').eq('mode', mode).eq('month', m).eq('year', y).order('category');
    query = scopeToAccount(query, account);

    const { data, error } = await query;
    if (error) { sendError(res, error.message, 500); return; }
    sendSuccess(res, data || []);
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// POST /api/budgets — upsert
// Personal budgets are unique per (user_id, category, mode, month, year).
// Business budgets are unique per (company_id, category, month, year) — see
// idx_budgets_company_unique — so any teammate updating the same category's
// budget for the month updates the one shared row instead of creating a
// duplicate.
export const createBudget = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { category, limit, month, year } = req.body;
    const account = req.user!;
    const mode = account.mode; // a budget always belongs to the account's own mode
    const now = new Date();
    const m = month || now.getMonth() + 1;
    const y = year  || now.getFullYear();

    if (mode === 'business') {
      if (!account.company_id) { sendError(res, 'This account is not part of a company', 400); return; }

      const { data, error } = await supabase
        .from('budgets')
        .upsert(
          { user_id: account.id, company_id: account.company_id, category, limit: Number(limit), mode, month: m, year: y },
          { onConflict: 'company_id,category,month,year' }
        )
        .select()
        .single();

      if (error) { sendError(res, error.message, 500); return; }
      sendSuccess(res, data, 'Budget saved', 201);
      return;
    }

    const { data, error } = await supabase
      .from('budgets')
      .upsert(
        { user_id: account.id, company_id: null, category, limit: Number(limit), mode, month: m, year: y },
        { onConflict: 'user_id,category,mode,month,year' }
      )
      .select()
      .single();

    if (error) { sendError(res, error.message, 500); return; }
    sendSuccess(res, data, 'Budget saved', 201);
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// PUT /api/budgets/:id
export const updateBudget = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let query = supabase.from('budgets').update({ limit: Number(req.body.limit) }).eq('id', req.params.id);
    query = scopeToAccount(query, req.user!);
    const { data, error } = await query.select().single();
    if (error || !data) { sendError(res, 'Budget not found', 404); return; }
    sendSuccess(res, data);
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// DELETE /api/budgets/:id
// For business accounts, any teammate can delete any shared budget — equal
// access within a company, no admin/member distinction.
export const deleteBudget = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let query = supabase.from('budgets').delete().eq('id', req.params.id);
    query = scopeToAccount(query, req.user!);
    const { error } = await query;
    if (error) { sendError(res, 'Budget not found', 404); return; }
    sendSuccess(res, null, 'Budget deleted');
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// POST /api/budgets/sync — kept for internal/import use; recalculates spent.
// No longer needs to be called from the UI — getBudgets already auto-syncs.
export const syncBudgetSpent = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { month, year } = req.body;
    const now = new Date();
    const m = Number(month) || now.getMonth() + 1;
    const y = Number(year) || now.getFullYear();

    await recalcSpent(req.user!, m, y);
    sendSuccess(res, { synced: true }, 'Budgets synced');
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};
