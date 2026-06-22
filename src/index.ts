import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { logger } from './utils/logger';
import { supabase } from './lib/supabase';
import authRoutes        from './routes/auth';
import transactionRoutes from './routes/transactions';
import budgetRoutes      from './routes/budgets';
import aiRoutes          from './routes/ai';
import importRoutes      from './routes/import';
import companyRoutes     from './routes/company';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 5000;

// General limiter — generous, just to stop runaway/scripted abuse. Normal
// app usage (Dashboard loading summary + monthly + by-category + budgets +
// transactions on every page visit, for every teammate in a company) adds
// up fast; 100 requests per 15 minutes was far too low and caused everyday
// use to trip "Too many requests."
const generalLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      Number(process.env.RATE_LIMIT_MAX)       || 1000,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down and try again shortly.' },
});

// Stricter limiter for the auth endpoints that actually need brute-force
// protection (login, register, password reset). Kept separate from the
// general limiter so it can be tight without affecting normal app usage.
const authLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      Number(process.env.AUTH_RATE_LIMIT_MAX)       || 30,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please wait a few minutes and try again.' },
});

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true }));
app.use(generalLimiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use('/api/auth/login',            authLimiter);
app.use('/api/auth/register',         authLimiter);
app.use('/api/auth/forgot-password',  authLimiter);
app.use('/api/auth/reset-password',   authLimiter);

app.use('/api/auth',         authRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/budgets',      budgetRoutes);
app.use('/api/ai',           aiRoutes);
app.use('/api/import',       importRoutes);
app.use('/api/company',      companyRoutes);

app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(err.message);
  res.status(500).json({ success: false, message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

const start = async () => {
  const { error } = await supabase.from('users').select('id').limit(1);
  if (error && error.code !== 'PGRST116') {
    logger.error('❌ Supabase connection failed: ' + error.message);
    logger.error('   → Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
    logger.error('   → Make sure you ran the SQL schema in your Supabase project');
    process.exit(1);
  }
  logger.info('✅ Supabase connected');
  app.listen(PORT, () => logger.info(`🚀 Server running on http://localhost:${PORT}`));
};

start();
export default app;
