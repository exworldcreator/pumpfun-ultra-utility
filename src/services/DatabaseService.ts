import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export class DatabaseService {
  private pool: Pool;
  private static instance: DatabaseService;

  private constructor() {
    const config: PoolConfig = {
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: 20, // Максимальное количество клиентов в пуле
      idleTimeoutMillis: 30000
    };

    this.pool = new Pool(config);

    // Обработка ошибок пула
    this.pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }

  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  public async query(text: string, params?: any[]) {
    try {
      const result = await this.pool.query(text, params);
      return result;
    } catch (error) {
      console.error('Database query error:', error);
      throw error;
    }
  }

  public async getClient() {
    return await this.pool.connect();
  }
} 