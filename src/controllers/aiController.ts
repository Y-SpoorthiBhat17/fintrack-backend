import { Response } from 'express';
import { supabase } from '../lib/supabase';
import { sendSuccess, sendError } from '../utils/response';
import { AuthRequest } from '../middleware/auth';

interface Transaction {
  amount: number;
  type: string;
  category: string;
  date: string;
}

interface BudgetRow {
  category: string;
  limit: number;
  spent: number;
}

// Free OpenRouter model slugs change over time — a hardcoded single model
// (e.g. the old "google/gemma-2-9b-it:free") can start 404'ing once the
// provider renames or removes it. To stay resilient we try a short list of
// currently-live free models, then fall back to OpenRouter's own
// "openrouter/free" auto-router, which always points at *something* that's
// actually available right now — this is what eliminates the 404 entirely.
const FALLBACK_MODELS = [
  process.env.OPENROUTER_MODEL || 'deepseek/deepseek-r1:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'openrouter/free', // auto-router — always resolves to a live free model
];

async function callOpenRouter(apiKey: string, prompt: string): Promise<string> {
  let lastError = '';

  for (const model of FALLBACK_MODELS) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.FRONTEND_URL || 'https://fintrack-frontend-aj6y.onrender.com',
          'X-Title': 'FinTrack Pro',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 900,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        lastError = `${model}: ${response.status} ${await response.text()}`;
        continue; // try next model
      }

      const data = await response.json() as {
        choices?: { message?: { content?: string; reasoning_content?: string } }[];
      };

      // Some free models (e.g. DeepSeek R1) put the answer in
      // reasoning_content instead of content — handle both.
      const content =
        data.choices?.[0]?.message?.content ||
        data.choices?.[0]?.message?.reasoning_content ||
        '';

      if (content.trim()) return content.trim();

      lastError = `${model}: empty response`;
    } catch (e) {
      lastError = `${model}: ${(e as Error).message}`;
    }
  }

  throw new Error(`All AI models failed. Last error: ${lastError}`);
}

// Personal data is owned by the individual user. Business data is shared
// across the whole company.
function scopeToAccount(query: any, user: { id: string; mode: string; company_id?: string | null }) {
  if (user.mode === 'business') {
    if (!user.company_id) return query.eq('company_id', '00000000-0000-0000-0000-000000000000');
    return query.eq('company_id', user.company_id);
  }
  return query.eq('user_id', user.id);
}

// GET /api/ai/insights
export const getInsights = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const account = req.user!;
    const mode = account.mode; // always the account's real mode

    // Anchor the "last 30 days" window to the most recent transaction date,
    // not today — a historical CSV import (e.g. data from months ago) would
    // otherwise always look empty even though real data exists.
    let latestQuery = supabase.from('transactions').select('date').eq('mode', mode);
    latestQuery = scopeToAccount(latestQuery, account);
    const { data: latest } = await latestQuery.order('date', { ascending: false }).limit(1).single();

    const anchorDate = latest ? new Date(latest.date) : new Date();
    const since = new Date(anchorDate);
    since.setDate(since.getDate() - 29);

    const month = anchorDate.getMonth() + 1;
    const year = anchorDate.getFullYear();

    let txQuery = supabase
      .from('transactions')
      .select('*')
      .eq('mode', mode)
      .gte('date', since.toISOString().split('T')[0])
      .lte('date', anchorDate.toISOString().split('T')[0])
      .order('date', { ascending: false })
      .limit(1000);
    txQuery = scopeToAccount(txQuery, account);

    const { data: txData, error: txError } = await txQuery;
    if (txError) throw new Error(txError.message);

    const txns: Transaction[] = txData || [];

    // This month's (i.e. the data's most recent month's) budgets — so AI
    // insights can reference real targets, not just raw spending.
    let budgetQuery = supabase.from('budgets').select('category, limit, spent').eq('mode', mode).eq('month', month).eq('year', year);
    budgetQuery = scopeToAccount(budgetQuery, account);
    const { data: budgetData } = await budgetQuery;

    const budgets: BudgetRow[] = budgetData || [];

    if (txns.length === 0) {
      sendSuccess(res, { insights: 'No transactions found yet. Add some transactions first to get AI-powered insights!' });
      return;
    }

    // Build summary stats
    const income = txns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const expense = txns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const savings = income - expense;
    const savingsRate = income > 0 ? ((savings / income) * 100).toFixed(1) : '0';

    const categoryMap: Record<string, number> = {};
    txns.filter(t => t.type === 'expense').forEach(t => {
      categoryMap[t.category] = (categoryMap[t.category] || 0) + t.amount;
    });
    const topCategories = Object.entries(categoryMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([cat, amt]) => `${cat}: ₹${amt.toLocaleString()}`)
      .join(', ');

    const budgetSummary = budgets.length > 0
      ? budgets.map(b => {
          const pct = b.limit > 0 ? Math.round((b.spent / b.limit) * 100) : 0;
          const status = pct >= 100 ? 'OVER BUDGET' : pct >= 80 ? 'near limit' : 'on track';
          return `${b.category}: budget ₹${b.limit.toLocaleString()}, spent ₹${b.spent.toLocaleString()} (${pct}% — ${status})`;
        }).join('\n  ')
      : 'No budgets have been set yet.';

    const prompt = `You are a helpful financial advisor for a ${mode === 'business' ? 'small business owner' : 'individual'} in India.

Here is their financial summary for the last 30 days:
- Total Income: ₹${income.toLocaleString()}
- Total Expenses: ₹${expense.toLocaleString()}
- Net Savings: ₹${savings.toLocaleString()}
- Savings Rate: ${savingsRate}%
- Top Expense Categories: ${topCategories}
- Total Transactions: ${txns.length}

Their budgets for this month (category — limit vs. actual spend):
  ${budgetSummary}

Please provide:
1. A brief overall financial health assessment (give a score out of 10)
2. Key observations about their spending patterns (3-4 bullet points)
3. Specifically call out any budget categories that are over or near their limit, and explain what's driving that
4. Concrete, actionable recommendations for next month — including budget changes if any category is unrealistic (3-4 bullet points)
5. A simple 12-month projection if they follow your advice

Format it clearly with markdown headings. Keep it concise, practical, and encouraging. Use ₹ for currency.`;

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      sendError(res, 'AI service not configured. Add OPENROUTER_API_KEY to your .env file. Get a free key at openrouter.ai', 503);
      return;
    }

    const insights = await callOpenRouter(apiKey, prompt);

    sendSuccess(res, {
      insights,
      stats: { income, expense, savings, savingsRate, transactionCount: txns.length, budgets },
    });
  } catch (err: unknown) {
    sendError(res, (err as Error).message, 500);
  }
};
