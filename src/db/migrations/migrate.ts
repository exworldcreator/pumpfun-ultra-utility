import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../../services/DatabaseService';
import { Keypair } from '@solana/web3.js';
import dotenv from 'dotenv';

dotenv.config();

interface WalletData {
  publicKey: string;
  privateKey: string;
  index: number;
  type: 'dev' | 'bundle' | 'bundle_payer' | 'market_maker' | 'market_maker_payer';
}

interface WalletSetData {
  id: string;
  createdAt: string;
  wallets: {
    NUMBER: string;
    TYPE: string;
    PUBLIC_KEY: string;
    PRIVATE_KEY: string;
  }[];
}

async function migrateWalletsToDatabase() {
  try {
    console.log('Starting wallet migration to PostgreSQL...');
    
    // Получаем экземпляр DatabaseService
    const dbService = DatabaseService.getInstance();
    
    // Проверяем, существует ли таблица wallets
    const tableExists = await dbService.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'wallets'
      );
    `);
    
    // Если таблица не существует, создаем ее
    if (!tableExists.rows[0].exists) {
      console.log('Creating wallets table...');
      const sqlFilePath = path.join(__dirname, '001_create_wallets_table.sql');
      const sqlScript = fs.readFileSync(sqlFilePath, 'utf8');
      await dbService.query(sqlScript);
      console.log('Wallets table created successfully.');
    }
    
    // Проверяем, есть ли уже данные в таблице
    const walletsCount = await dbService.query('SELECT COUNT(*) FROM wallets');
    if (parseInt(walletsCount.rows[0].count) > 0) {
      console.log(`Found ${walletsCount.rows[0].count} wallets in the database. Skipping migration.`);
      return;
    }
    
    // Пытаемся загрузить данные из wallet-sets.json
    let wallets: { [key: number]: { publicKey: string, privateKey: string, type: string } } = {};
    
    const walletSetsPath = path.join(__dirname, '../../../db/wallet-sets.json');
    if (fs.existsSync(walletSetsPath)) {
      console.log('Loading wallets from wallet-sets.json...');
      const data = fs.readFileSync(walletSetsPath, 'utf8');
      const sets = JSON.parse(data) as Record<string, WalletSetData>;
      
      // Получаем самый последний набор кошельков
      const mostRecentSet = Object.values(sets)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      
      if (mostRecentSet && mostRecentSet.wallets) {
        mostRecentSet.wallets.forEach(walletData => {
          const index = parseInt(walletData.NUMBER, 10);
          wallets[index] = {
            publicKey: walletData.PUBLIC_KEY,
            privateKey: walletData.PRIVATE_KEY,
            type: walletData.TYPE
          };
        });
        console.log(`Loaded ${Object.keys(wallets).length} wallets from wallet-sets.json`);
      }
    } else {
      // Если wallet-sets.json не существует, пытаемся загрузить из wallets.json
      const walletsPath = path.join(__dirname, '../../../wallets.json');
      if (fs.existsSync(walletsPath)) {
        console.log('Loading wallets from wallets.json...');
        const data = fs.readFileSync(walletsPath, 'utf8');
        const walletsData: WalletData[] = JSON.parse(data);
        
        walletsData.forEach(walletData => {
          wallets[walletData.index] = {
            publicKey: walletData.publicKey,
            privateKey: walletData.privateKey,
            type: walletData.type
          };
        });
        console.log(`Loaded ${Object.keys(wallets).length} wallets from wallets.json`);
      }
    }
    
    // Если нет данных для миграции, генерируем новые кошельки
    if (Object.keys(wallets).length === 0) {
      console.log('No existing wallets found. Generating new wallets...');
      
      // Генерируем dev wallet (0)
      const devWallet = Keypair.generate();
      wallets[0] = {
        publicKey: devWallet.publicKey.toString(),
        privateKey: Buffer.from(devWallet.secretKey).toString('base64'),
        type: 'dev'
      };
      
      // Генерируем bundle wallets (1-23)
      for (let i = 1; i <= 23; i++) {
        const wallet = Keypair.generate();
        wallets[i] = {
          publicKey: wallet.publicKey.toString(),
          privateKey: Buffer.from(wallet.secretKey).toString('base64'),
          type: 'bundle'
        };
      }
      
      // Генерируем bundle payer wallet (24)
      const bundlePayerWallet = Keypair.generate();
      wallets[24] = {
        publicKey: bundlePayerWallet.publicKey.toString(),
        privateKey: Buffer.from(bundlePayerWallet.secretKey).toString('base64'),
        type: 'bundle_payer'
      };
      
      // Генерируем market making payer wallet (25)
      const marketMakingPayerWallet = Keypair.generate();
      wallets[25] = {
        publicKey: marketMakingPayerWallet.publicKey.toString(),
        privateKey: Buffer.from(marketMakingPayerWallet.secretKey).toString('base64'),
        type: 'market_maker_payer'
      };
      
      // Генерируем market making wallets (26-100)
      for (let i = 26; i <= 100; i++) {
        const wallet = Keypair.generate();
        wallets[i] = {
          publicKey: wallet.publicKey.toString(),
          privateKey: Buffer.from(wallet.secretKey).toString('base64'),
          type: 'market_maker'
        };
      }
      
      console.log(`Generated ${Object.keys(wallets).length} new wallets`);
    }
    
    // Вставляем данные в базу данных
    console.log('Inserting wallets into the database...');
    
    // Используем транзакцию для атомарной вставки
    const client = await dbService.getClient();
    try {
      await client.query('BEGIN');
      
      for (const [index, wallet] of Object.entries(wallets)) {
        await client.query(
          `INSERT INTO wallets (wallet_number, public_key, private_key, wallet_type) 
           VALUES ($1, $2, $3, $4)`,
          [parseInt(index), wallet.publicKey, wallet.privateKey, wallet.type]
        );
      }
      
      await client.query('COMMIT');
      console.log(`Successfully migrated ${Object.keys(wallets).length} wallets to the database.`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error during database transaction:', error);
      throw error;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

// Запускаем миграцию
migrateWalletsToDatabase().then(() => {
  console.log('Migration completed successfully.');
  process.exit(0);
}).catch(error => {
  console.error('Migration failed:', error);
  process.exit(1);
}); 