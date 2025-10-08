import { log } from './vite';
import { db } from './db';
import { sql } from 'drizzle-orm';

interface DatabaseHealthConfig {
  checkInterval: number;
  autoFix: boolean;
  maxIssuesPerCheck: number;
}

export class SimpleDatabaseMonitor {
  private config: DatabaseHealthConfig;
  private isRunning: boolean = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private lastCheck: Date | null = null;
  private totalIssuesFixed: number = 0;
  private totalChecks: number = 0;

  constructor(config: Partial<DatabaseHealthConfig> = {}) {
    this.config = {
      checkInterval: 5 * 60 * 1000, // 5 minutes
      autoFix: true,
      maxIssuesPerCheck: 10,
      ...config
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      log('[DB-MONITOR] Monitor is already running', 'warn');
      return;
    }

    this.isRunning = true;
    log('[DB-MONITOR] Starting simple database health monitor', 'info');
    
    // Run initial check
    await this.performHealthCheck();
    
    // Set up periodic checks
    this.checkInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, this.config.checkInterval);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    log('[DB-MONITOR] Stopped database health monitor', 'info');
  }

  private async performHealthCheck(): Promise<void> {
    try {
      this.totalChecks++;
      this.lastCheck = new Date();
      
      log(`[DB-MONITOR] Performing health check #${this.totalChecks}`, 'debug');
      
      const issues = await this.detectIssues();
      
      if (issues.length === 0) {
        log('[DB-MONITOR] No issues detected - database is healthy', 'debug');
        return;
      }

      log(`[DB-MONITOR] Found ${issues.length} potential issues`, 'warn');
      
      if (this.config.autoFix) {
        await this.autoFixIssues(issues);
      } else {
        log('[DB-MONITOR] Auto-fix disabled - issues logged but not fixed', 'warn');
        issues.forEach(issue => {
          log(`[DB-MONITOR] Issue: ${issue.table}.${issue.field} (ID: ${issue.id}) = "${issue.value}"`, 'warn');
        });
      }
      
    } catch (error) {
      log(`[DB-MONITOR] Error during health check: ${error}`, 'error');
    }
  }

  private async detectIssues(): Promise<Array<{
    table: string;
    id: number;
    field: string;
    value: string;
    type: string;
  }>> {
    const issues: Array<{
      table: string;
      id: number;
      field: string;
      value: string;
      type: string;
    }> = [];

    try {
      // Check categories table using Drizzle
      const categoriesResult = await db.execute(sql`
        SELECT id, name, discord_role_id, discord_category_id, transcript_category_id
        FROM categories
        WHERE 
          (discord_role_id IS NOT NULL AND (discord_role_id !~ '^\\d{17,19}$' OR discord_role_id = '')) OR
          (discord_category_id IS NOT NULL AND (discord_category_id !~ '^\\d{17,19}$' OR discord_category_id = '')) OR
          (transcript_category_id IS NOT NULL AND (transcript_category_id !~ '^\\d{17,19}$' OR transcript_category_id = ''))
      `);

      for (const category of categoriesResult.rows) {
        if (category.discord_role_id && !/^\d{17,19}$/.test(category.discord_role_id)) {
          issues.push({
            table: 'categories',
            id: category.id,
            field: 'discord_role_id',
            value: category.discord_role_id,
            type: 'invalid_discord_id'
          });
        }
        if (category.discord_category_id && !/^\d{17,19}$/.test(category.discord_category_id)) {
          issues.push({
            table: 'categories',
            id: category.id,
            field: 'discord_category_id',
            value: category.discord_category_id,
            type: 'invalid_discord_id'
          });
        }
        if (category.transcript_category_id && !/^\d{17,19}$/.test(category.transcript_category_id)) {
          issues.push({
            table: 'categories',
            id: category.id,
            field: 'transcript_category_id',
            value: category.transcript_category_id,
            type: 'invalid_discord_id'
          });
        }
      }

      // Check tickets table
      const ticketsResult = await db.execute(sql`
        SELECT id, discord_channel_id, claimed_by
        FROM tickets
        WHERE 
          (discord_channel_id IS NOT NULL AND (discord_channel_id !~ '^\\d{17,19}$' OR discord_channel_id = '')) OR
          (claimed_by IS NOT NULL AND (claimed_by !~ '^\\d{17,19}$' OR claimed_by = ''))
      `);

      for (const ticket of ticketsResult.rows) {
        if (ticket.discord_channel_id && !/^\d{17,19}$/.test(ticket.discord_channel_id)) {
          issues.push({
            table: 'tickets',
            id: ticket.id,
            field: 'discord_channel_id',
            value: ticket.discord_channel_id,
            type: 'invalid_discord_id'
          });
        }
        if (ticket.claimed_by && !/^\d{17,19}$/.test(ticket.claimed_by)) {
          issues.push({
            table: 'tickets',
            id: ticket.id,
            field: 'claimed_by',
            value: ticket.claimed_by,
            type: 'invalid_discord_id'
          });
        }
      }

      // Check users table
      const usersResult = await db.execute(sql`
        SELECT id, discord_id, banned_by
        FROM users
        WHERE 
          (discord_id IS NOT NULL AND (discord_id !~ '^\\d{17,19}$' OR discord_id = '')) OR
          (banned_by IS NOT NULL AND (banned_by !~ '^\\d{17,19}$' OR banned_by = ''))
      `);

      for (const user of usersResult.rows) {
        if (user.discord_id && !/^\d{17,19}$/.test(user.discord_id)) {
          issues.push({
            table: 'users',
            id: user.id,
            field: 'discord_id',
            value: user.discord_id,
            type: 'invalid_discord_id'
          });
        }
        if (user.banned_by && !/^\d{17,19}$/.test(user.banned_by)) {
          issues.push({
            table: 'users',
            id: user.id,
            field: 'banned_by',
            value: user.banned_by,
            type: 'invalid_discord_id'
          });
        }
      }

    } catch (error) {
      log(`[DB-MONITOR] Error detecting issues: ${error}`, 'error');
    }

    return issues;
  }

  private async autoFixIssues(issues: Array<{
    table: string;
    id: number;
    field: string;
    value: string;
    type: string;
  }>): Promise<void> {
    const issuesToFix = issues.slice(0, this.config.maxIssuesPerCheck);
    
    log(`[DB-MONITOR] Auto-fixing ${issuesToFix.length} issues (max ${this.config.maxIssuesPerCheck} per check)`, 'info');

    for (const issue of issuesToFix) {
      try {
        await this.fixIssue(issue);
        this.totalIssuesFixed++;
        log(`[DB-MONITOR] Fixed ${issue.table}.${issue.field} (ID: ${issue.id})`, 'info');
      } catch (error) {
        log(`[DB-MONITOR] Failed to fix ${issue.table}.${issue.field} (ID: ${issue.id}): ${error}`, 'error');
      }
    }

    if (issues.length > this.config.maxIssuesPerCheck) {
      log(`[DB-MONITOR] ${issues.length - this.config.maxIssuesPerCheck} more issues will be fixed in next check`, 'info');
    }
  }

  private async fixIssue(issue: {
    table: string;
    id: number;
    field: string;
    value: string;
    type: string;
  }): Promise<void> {
    const { table, id, field } = issue;
    
    // Set the invalid field to NULL using Drizzle
    await db.execute(sql`
      UPDATE ${sql.identifier(table)} 
      SET ${sql.identifier(field)} = NULL 
      WHERE id = ${id}
    `);
  }

  getStatus(): {
    isRunning: boolean;
    lastCheck: Date | null;
    totalChecks: number;
    totalIssuesFixed: number;
    config: DatabaseHealthConfig;
  } {
    return {
      isRunning: this.isRunning,
      lastCheck: this.lastCheck,
      totalChecks: this.totalChecks,
      totalIssuesFixed: this.totalIssuesFixed,
      config: this.config
    };
  }
} 