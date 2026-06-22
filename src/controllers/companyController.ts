import { Response } from 'express';
import { supabase } from '../lib/supabase';
import { sendSuccess, sendError } from '../utils/response';
import { AuthRequest } from '../middleware/auth';

// GET /api/company/me
// Returns the current user's company info (name + invite code) so it can be
// shared with teammates at any time after signup, not just once.
export const getMyCompany = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (req.user!.mode !== 'business' || !req.user!.company_id) {
      sendError(res, 'This account is not part of a company', 400); return;
    }

    const { data: company, error } = await supabase
      .from('companies')
      .select('id, name, invite_code, currency, created_at')
      .eq('id', req.user!.company_id)
      .single();

    if (error || !company) { sendError(res, 'Company not found', 404); return; }

    const { count } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', company.id);

    sendSuccess(res, { ...company, memberCount: count ?? 1 });
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};
