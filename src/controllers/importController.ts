import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { sendSuccess, sendError } from '../utils/response';

// Insert in chunks so large imports (500+ rows, income + expense mixed
// together) don't hit a single oversized request to Supabase/PostgREST.
const INSERT_BATCH_SIZE = 250;

// POST /api/import/csv
export const importFromCSV = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const mode = req.user!.mode; // imported transactions always belong to the account's own mode
    const companyId = req.user!.company_id || null;

    if (mode === 'business' && !companyId) {
      sendError(res, 'This account is not part of a company yet', 400); return;
    }

    const { rows, columnMap } = req.body as {
      rows: Record<string, string>[];
      columnMap: { date?: string; amount?: string; description?: string; category?: string; type?: string; credit?: string; debit?: string; };
    };

    if (!Array.isArray(rows) || rows.length === 0) {
      sendError(res, 'No CSV rows provided'); return;
    }

    const toInsert: object[] = [];
    const errors: string[] = [];

    // No row-count cap here — a company's CSV/Excel export can easily
    // contain 500+ transactions (income and expense mixed together) and all
    // of them should be processed in one upload.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        let amount = 0;
        let type: 'income' | 'expense' = 'expense';

        if (columnMap.credit && columnMap.debit) {
          const credit = parseFloat((row[columnMap.credit] || '0').replace(/[₹,\s]/g, ''));
          const debit  = parseFloat((row[columnMap.debit]  || '0').replace(/[₹,\s]/g, ''));
          if (credit > 0)     { amount = credit; type = 'income'; }
          else if (debit > 0) { amount = debit;  type = 'expense'; }
          else { errors.push(`Row ${i+2}: no amount`); continue; }
        } else if (columnMap.amount) {
          amount = parseFloat((row[columnMap.amount] || '0').replace(/[₹,\s]/g, ''));
          if (columnMap.type) {
            const t = (row[columnMap.type] || '').toLowerCase().trim();
            // Recognize common ways "income" shows up across different
            // bank/accounting exports: the word itself, "credit"/"cr" as a
            // whole word, or a credited transaction. Deliberately not
            // matching bare "cr" as a loose substring — that's too easy to
            // false-match against unrelated text.
            type = /^(income|credit|cr)$/.test(t) || t.includes('income') || t.includes('credit')
              ? 'income'
              : 'expense';
          }
        }

        if (!amount || amount <= 0) { errors.push(`Row ${i+2}: invalid amount`); continue; }

        const dateStr = columnMap.date ? row[columnMap.date] : '';
        const parsedDate = dateStr ? new Date(dateStr) : new Date();
        if (isNaN(parsedDate.getTime())) { errors.push(`Row ${i+2}: invalid date`); continue; }

        toInsert.push({
          user_id: req.user!.id, // who actually ran the import, for audit purposes
          company_id: mode === 'business' ? companyId : null, // who it's shared with
          type, amount,
          category:    columnMap.category    ? (row[columnMap.category]    || 'Others') : (type === 'income' ? 'Revenue' : 'Operations'),
          description: columnMap.description ? (row[columnMap.description] || 'Imported').slice(0, 200) : 'CSV Import',
          date: parsedDate.toISOString().split('T')[0],
          mode,
        });
      } catch { errors.push(`Row ${i+2}: parse error`); }
    }

    if (toInsert.length === 0) {
      sendSuccess(res, { imported: 0, errors }, 'No valid rows. Check column mapping.'); return;
    }

    // Batch-insert so 500+ row files (income + expense together) go through
    // reliably instead of one oversized request.
    let imported = 0;
    for (let i = 0; i < toInsert.length; i += INSERT_BATCH_SIZE) {
      const batch = toInsert.slice(i, i + INSERT_BATCH_SIZE);
      const { error } = await supabase.from('transactions').insert(batch);
      if (error) {
        errors.push(`Batch ${Math.floor(i / INSERT_BATCH_SIZE) + 1}: ${error.message}`);
        continue;
      }
      imported += batch.length;
    }

    await syncBudgetsAfterImport(req.user!.id, mode, companyId);

    sendSuccess(res, { imported, errors }, `Imported ${imported} of ${rows.length} transactions`);
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// Helper: sync budgets after any bulk import
async function syncBudgetsAfterImport(userId: string, mode: string, companyId: string | null) {
  try {
    const now = new Date();
    const m = now.getMonth() + 1;
    const y = now.getFullYear();
    const start = `${y}-${String(m).padStart(2,'0')}-01`;
    const end   = new Date(y, m, 0).toISOString().split('T')[0];

    let bQuery = supabase.from('budgets').select('*').eq('mode', mode).eq('month', m).eq('year', y);
    bQuery = mode === 'business' ? bQuery.eq('company_id', companyId) : bQuery.eq('user_id', userId);
    const { data: budgets } = await bQuery;
    if (!budgets?.length) return;

    await Promise.all(budgets.map(async (b) => {
      let txQuery = supabase.from('transactions').select('amount').eq('type', 'expense').eq('category', b.category).eq('mode', mode).gte('date', start).lte('date', end);
      txQuery = mode === 'business' ? txQuery.eq('company_id', companyId) : txQuery.eq('user_id', userId);
      const { data: txs } = await txQuery;
      const spent = (txs || []).reduce((s, t) => s + Number(t.amount), 0);
      await supabase.from('budgets').update({ spent }).eq('id', b.id);
    }));
  } catch { /* silent */ }
}
