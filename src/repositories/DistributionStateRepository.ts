import { Pool } from 'pg';
import { DistributionState, IDistributionStateRepository } from '../services/TransactionService';
import * as dotenv from 'dotenv';

// Загружаем переменные окружения
dotenv.config();

export class DistributionStateRepository implements IDistributionStateRepository {
  private pool: Pool;

  constructor(pool?: Pool) {
    // Если пул не передан, создаем новый с настройками из переменных окружения
    if (!pool) {
      this.pool = new Pool({
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'solana_wallets',
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
      });
    } else {
      this.pool = pool;
    }
  }

  async initialize(): Promise<void> {
    try {
      // Создаем таблицу, если она не существует
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS distribution_states (
          user_id TEXT PRIMARY KEY,
          last_processed_wallet INTEGER NOT NULL,
          remaining_amount DECIMAL NOT NULL,
          base_amount DECIMAL NOT NULL,
          failed_attempts INTEGER NOT NULL,
          timestamp BIGINT NOT NULL
        )
      `);
      console.log('Distribution states table initialized successfully');
    } catch (error) {
      console.error('Error initializing distribution states table:', error);
      throw error;
    }
  }

  async saveState(state: DistributionState): Promise<void> {
    if (!state.userId) {
      throw new Error('User ID is required for saving distribution state');
    }

    await this.pool.query(
      `INSERT INTO distribution_states 
       (user_id, last_processed_wallet, remaining_amount, base_amount, failed_attempts, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         last_processed_wallet = $2,
         remaining_amount = $3,
         base_amount = $4,
         failed_attempts = $5,
         timestamp = $6`,
      [
        state.userId,
        state.lastProcessedWallet,
        state.remainingAmount,
        state.baseAmount,
        state.failedAttempts,
        state.timestamp || Date.now()
      ]
    );
  }

  async getState(userId: string): Promise<DistributionState | null> {
    const result = await this.pool.query(
      `SELECT * FROM distribution_states WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      userId: row.user_id,
      lastProcessedWallet: row.last_processed_wallet,
      remainingAmount: parseFloat(row.remaining_amount),
      baseAmount: parseFloat(row.base_amount),
      failedAttempts: row.failed_attempts,
      timestamp: row.timestamp
    };
  }

  async deleteState(userId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM distribution_states WHERE user_id = $1`,
      [userId]
    );
  }

  async getAllStates(): Promise<DistributionState[]> {
    const result = await this.pool.query(`SELECT * FROM distribution_states`);
    
    return result.rows.map(row => ({
      userId: row.user_id,
      lastProcessedWallet: row.last_processed_wallet,
      remainingAmount: parseFloat(row.remaining_amount),
      baseAmount: parseFloat(row.base_amount),
      failedAttempts: row.failed_attempts,
      timestamp: row.timestamp
    }));
  }

  async getActiveStates(olderThanMinutes: number = 60): Promise<DistributionState[]> {
    const cutoffTime = Date.now() - (olderThanMinutes * 60 * 1000);
    
    const result = await this.pool.query(
      `SELECT * FROM distribution_states WHERE timestamp > $1`,
      [cutoffTime]
    );
    
    return result.rows.map(row => ({
      userId: row.user_id,
      lastProcessedWallet: row.last_processed_wallet,
      remainingAmount: parseFloat(row.remaining_amount),
      baseAmount: parseFloat(row.base_amount),
      failedAttempts: row.failed_attempts,
      timestamp: row.timestamp
    }));
  }
} 