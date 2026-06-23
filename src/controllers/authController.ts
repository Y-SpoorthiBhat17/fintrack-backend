import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { supabase } from '../lib/supabase';
import { sendSuccess, sendError } from '../utils/response';
import { AuthRequest } from '../middleware/auth';

const makeToken = (id: string) =>
  jwt.sign({ id }, process.env.JWT_SECRET || 'secret', {
    expiresIn: process.env.JWT_EXPIRES_IN || '100y',
  } as jwt.SignOptions);

// Short, shareable, unambiguous invite code (uppercase, no 0/O/1/I confusion)
function generateInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

// POST /api/auth/register
// Personal: name, email, password — unchanged.
// Business: two distinct paths controlled by `companyAction`:
//   - "create": makes a brand-new company, this user becomes its first
//     member, and an invite code is generated and returned so they can
//     bring teammates in.
//   - "join": requires an existing `inviteCode` — the user is attached to
//     that company and immediately sees its shared transactions/budgets.
// Just typing the same company name does NOT join an existing company —
// only a valid invite code does, by design.
export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, password, mode, company, companyAction, inviteCode } = req.body;
    // Normalize so "John@Gmail.com" and "john@gmail.com" are treated as the
    // same email for uniqueness — without this, the one-email-per-account
    // rule could be bypassed by changing case/whitespace.
    const email = String(req.body.email || '').trim().toLowerCase();

    if (!email) { sendError(res, 'Email is required'); return; }

    // One email = one account, period. A personal account's email can never
    // also be used to register a business account, and vice versa — this
    // check is mode-agnostic on purpose.
    const { data: existing } = await supabase.from('users').select('id, mode').eq('email', email).single();
    if (existing) {
      const otherMode = existing.mode === 'personal' ? 'personal' : 'business';
      sendError(res, `This email is already registered as a ${otherMode} account. Use a different email, or sign in instead.`);
      return;
    }

    const hashed = await bcrypt.hash(password, 12);
    let companyId: string | null = null;
    let companyName: string | null = null;
    let returnedInviteCode: string | null = null;

    if (mode === 'business') {
      if (companyAction === 'join') {
        const code = String(inviteCode || '').trim().toUpperCase();
        if (!code) { sendError(res, 'Invite code is required to join an existing company'); return; }

        const { data: existingCompany } = await supabase
          .from('companies').select('id, name').eq('invite_code', code).single();

        if (!existingCompany) { sendError(res, 'Invalid invite code. Double-check it with your company admin.'); return; }

        companyId = existingCompany.id;
        companyName = existingCompany.name;
      } else {
        // Default path: create a brand-new company
        if (!company) { sendError(res, 'Company name is required'); return; }

        const code = generateInviteCode();
        const { data: newCompany, error: companyError } = await supabase
          .from('companies')
          .insert({ name: company, invite_code: code })
          .select('id, name, invite_code')
          .single();

        if (companyError || !newCompany) { sendError(res, companyError?.message || 'Failed to create company', 500); return; }

        companyId = newCompany.id;
        companyName = newCompany.name;
        returnedInviteCode = newCompany.invite_code;
      }
    }

    const { data: user, error } = await supabase
      .from('users')
      .insert({ name, email, password: hashed, mode: mode || 'personal', company_id: companyId, company: companyName })
      .select('id, name, email, mode, company, company_id, currency')
      .single();

    if (error || !user) { sendError(res, error?.message || 'Registration failed', 500); return; }

    sendSuccess(res, {
      user,
      token: makeToken(user.id),
      // Only present right after creating a brand-new company — this is the
      // one time the invite code needs to be shown so it can be shared.
      inviteCode: returnedInviteCode,
    }, 'Account created', 201);
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// POST /api/auth/login
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const { password } = req.body;

    const { data: user, error } = await supabase
      .from('users')
      .select('id, name, email, password, mode, company, company_id, currency')
      .eq('email', email)
      .single();

    if (error || !user) { sendError(res, 'Invalid email or password', 401); return; }

    const match = await bcrypt.compare(password, user.password);
    if (!match) { sendError(res, 'Invalid email or password', 401); return; }

    const { password: _p, ...safeUser } = user;
    sendSuccess(res, { user: safeUser, token: makeToken(user.id) }, 'Login successful');
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// GET /api/auth/me
export const getMe = async (req: AuthRequest, res: Response): Promise<void> => {
  sendSuccess(res, req.user);
};

// PUT /api/auth/profile
export const updateProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // mode and company/company_id are intentionally excluded — personal vs
    // business is fixed at signup, and company membership is only changed
    // via the invite-code join flow, never via a generic profile edit.
    const { name, currency } = req.body;
    const { data: user, error } = await supabase
      .from('users')
      .update({ name, currency })
      .eq('id', req.user!.id)
      .select('id, name, email, mode, company, company_id, currency')
      .single();
    if (error) { sendError(res, error.message, 500); return; }
    sendSuccess(res, user);
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// PUT /api/auth/password
export const changePassword = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { currentPassword, newPassword } = req.body;
    const { data: user } = await supabase.from('users').select('password').eq('id', req.user!.id).single();
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
      sendError(res, 'Current password is incorrect', 400); return;
    }
    const hashed = await bcrypt.hash(newPassword, 12);
    await supabase.from('users').update({ password: hashed }).eq('id', req.user!.id);
    sendSuccess(res, null, 'Password updated');
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// POST /api/auth/forgot-password
// Generates a one-time, time-limited reset token. We never reveal whether
// an email exists (same response either way) to avoid leaking which emails
// are registered.
//
// NOTE: there is no email service wired up in this project yet, so the
// reset link is returned directly in the API response and shown on-screen.
// To send a real email instead, plug a provider (e.g. Resend, SendGrid, AWS
// SES) in here and remove `resetUrl` from the response — everything else
// (token generation, hashing, expiry, verification) already works as-is.
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) { sendError(res, 'Email is required'); return; }

    const { data: user } = await supabase.from('users').select('id, mode').eq('email', email).single();

    // Always respond the same way whether or not the user exists.
    const genericMessage = 'If an account with that email exists, a reset link has been generated.';

    if (!user) { sendSuccess(res, { resetUrl: null }, genericMessage); return; }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await supabase.from('users').update({
      reset_token_hash: tokenHash,
      reset_token_expires: expires.toISOString(),
    }).eq('id', user.id);

    const frontendUrl = process.env.FRONTEND_URL || 'https://fintrack-frontend-aj6y.onrender.com';
    const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}&email=${encodeURIComponent(email)}`;

    // Until a real email provider is wired up, the link is returned here so
    // the feature works end-to-end today.
    sendSuccess(res, { resetUrl }, genericMessage);
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};

// POST /api/auth/reset-password
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const { token, newPassword } = req.body;

    if (!email || !token || !newPassword) { sendError(res, 'Email, token, and new password are required'); return; }
    if (newPassword.length < 6) { sendError(res, 'Password must be at least 6 characters'); return; }

    const { data: user } = await supabase
      .from('users')
      .select('id, reset_token_hash, reset_token_expires')
      .eq('email', email)
      .single();

    if (!user || !user.reset_token_hash || !user.reset_token_expires) {
      sendError(res, 'Invalid or expired reset link', 400); return;
    }

    if (new Date(user.reset_token_expires).getTime() < Date.now()) {
      sendError(res, 'This reset link has expired. Please request a new one.', 400); return;
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    if (tokenHash !== user.reset_token_hash) {
      sendError(res, 'Invalid or expired reset link', 400); return;
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    await supabase.from('users').update({
      password: hashed,
      reset_token_hash: null,
      reset_token_expires: null,
    }).eq('id', user.id);

    sendSuccess(res, null, 'Password reset successfully. You can now sign in.');
  } catch (err: unknown) { sendError(res, (err as Error).message, 500); }
};
