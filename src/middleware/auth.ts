import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase';
import { sendError } from '../utils/response';

export interface AuthRequest extends Request {
  user?: { id: string; email: string; name: string; mode: string; company?: string; company_id?: string | null; currency?: string };
}

export const protect = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) { sendError(res, 'Not authorized', 401); return; }

    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as { id: string };

    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, name, mode, company, company_id, currency')
      .eq('id', decoded.id)
      .single();

    if (error || !user) { sendError(res, 'User not found', 401); return; }

    req.user = user;
    next();
  } catch {
    sendError(res, 'Invalid token', 401);
  }
};
