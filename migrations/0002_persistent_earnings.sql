-- Migration: Add persistent earnings tracking tables
-- This ensures worker earnings are preserved even when tickets are deleted

-- Create earnings_ledger table for persistent earnings tracking
CREATE TABLE IF NOT EXISTS earnings_ledger (
  id SERIAL PRIMARY KEY,
  worker_id TEXT NOT NULL,
  ticket_id INTEGER REFERENCES tickets(id),
  category_id INTEGER REFERENCES categories(id),
  amount INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'ticket_payment',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMP,
  confirmed_by TEXT,
  notes TEXT
);

-- Create earnings_adjustments table for manual corrections
CREATE TABLE IF NOT EXISTS earnings_adjustments (
  id SERIAL PRIMARY KEY,
  worker_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  approved_by TEXT,
  approved_at TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT
);

-- Create worker_earnings_summary table for quick lookups
CREATE TABLE IF NOT EXISTS worker_earnings_summary (
  id SERIAL PRIMARY KEY,
  worker_id TEXT NOT NULL UNIQUE,
  total_earnings INTEGER NOT NULL DEFAULT 0,
  total_tickets INTEGER NOT NULL DEFAULT 0,
  last_earning_date TIMESTAMP,
  last_updated TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_earnings_ledger_worker_id ON earnings_ledger(worker_id);
CREATE INDEX IF NOT EXISTS idx_earnings_ledger_status ON earnings_ledger(status);
CREATE INDEX IF NOT EXISTS idx_earnings_ledger_type ON earnings_ledger(type);
CREATE INDEX IF NOT EXISTS idx_earnings_ledger_created_at ON earnings_ledger(created_at);

CREATE INDEX IF NOT EXISTS idx_earnings_adjustments_worker_id ON earnings_adjustments(worker_id);
CREATE INDEX IF NOT EXISTS idx_earnings_adjustments_status ON earnings_adjustments(status);

-- Migrate existing paid tickets to the earnings ledger
INSERT INTO earnings_ledger (worker_id, ticket_id, category_id, amount, type, reason, status, created_at, confirmed_at, confirmed_by)
SELECT 
  claimed_by,
  id,
  category_id,
  amount,
  'ticket_payment',
  'Migrated from existing paid ticket',
  'confirmed',
  COALESCE(completed_at, created_at),
  completed_at,
  'system'
FROM tickets 
WHERE claimed_by IS NOT NULL 
  AND amount > 0 
  AND status = 'paid'
  AND NOT EXISTS (
    SELECT 1 FROM earnings_ledger WHERE ticket_id = tickets.id
  );

-- Create initial worker earnings summaries
INSERT INTO worker_earnings_summary (worker_id, total_earnings, total_tickets, last_earning_date)
SELECT 
  worker_id,
  SUM(amount) as total_earnings,
  COUNT(*) as total_tickets,
  MAX(created_at) as last_earning_date
FROM earnings_ledger
WHERE status = 'confirmed' AND type = 'ticket_payment'
GROUP BY worker_id
ON CONFLICT (worker_id) DO UPDATE SET
  total_earnings = EXCLUDED.total_earnings,
  total_tickets = EXCLUDED.total_tickets,
  last_earning_date = EXCLUDED.last_earning_date,
  last_updated = NOW();
