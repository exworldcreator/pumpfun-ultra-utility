import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../../services/DatabaseService';
import { Keypair } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import { randomBytes } from 'crypto';
import bs58 from 'bs58';

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

// Функция для генерации уникального ID набора
function generateSetId(): string {
  // Генерируем случайные 4 байта и преобразуем их в hex
  const randomId = randomBytes(2).toString('hex');
  // Добавляем временную метку для уникальности
  const timestamp = Date.now().toString(36);
  return `${timestamp}-${randomId}`;
}

// Вспомогательная функция для конвертации в base58
function convertToBase58(secretKey: Uint8Array): string {
  return bs58.encode(secretKey);
}

async function migrateWalletsToDatabase() {
  try {
    console.log('Starting wallet migration to PostgreSQL...');
    
    // Получаем экземпляр DatabaseService
    const dbService = DatabaseService.getInstance();
    
    // Удаляем существующие таблицы
    console.log('Dropping existing tables...');
    await dbService.query('DROP TABLE IF EXISTS wallets CASCADE');
    await dbService.query('DROP TABLE IF EXISTS tokens CASCADE');
    
    // Создаем таблицы заново
    console.log('Creating tables...');
    const sqlFilePath = path.join(__dirname, '001_create_wallets_table.sql');
    const sqlScript = fs.readFileSync(sqlFilePath, 'utf8');
    await dbService.query(sqlScript);
    console.log('Tables created successfully.');
    
    // Загружаем все наборы кошельков из wallet-sets.json
    const walletSetsPath = path.join(__dirname, '../../../db/wallet-sets.json');
    if (!fs.existsSync(walletSetsPath)) {
      console.log('No wallet sets found, generating new set...');
      // Генерируем новый набор кошельков
      const newSetId = generateSetId();
      const wallets: { [key: number]: { publicKey: string, privateKey: string, type: string } } = {};
      
      // Генерируем dev wallet (0)
      const devWallet = Keypair.generate();
      wallets[0] = {
        publicKey: devWallet.publicKey.toString(),
        privateKey: convertToBase58(devWallet.secretKey),
        type: 'dev'
      };
      
      // Генерируем bundle wallets (1-23)
      for (let i = 1; i <= 23; i++) {
        const wallet = Keypair.generate();
        wallets[i] = {
          publicKey: wallet.publicKey.toString(),
          privateKey: convertToBase58(wallet.secretKey),
          type: 'bundle'
        };
      }
      
      // Генерируем bundle payer wallet (24)
      const bundlePayerWallet = Keypair.generate();
      wallets[24] = {
        publicKey: bundlePayerWallet.publicKey.toString(),
        privateKey: convertToBase58(bundlePayerWallet.secretKey),
        type: 'bundle_payer'
      };
      
      // Генерируем market making payer wallet (25)
      const marketMakingPayerWallet = Keypair.generate();
      wallets[25] = {
        publicKey: marketMakingPayerWallet.publicKey.toString(),
        privateKey: convertToBase58(marketMakingPayerWallet.secretKey),
        type: 'market_maker_payer'
      };
      
      // Генерируем market making wallets (26-100)
      for (let i = 26; i <= 100; i++) {
        const wallet = Keypair.generate();
        wallets[i] = {
          publicKey: wallet.publicKey.toString(),
          privateKey: convertToBase58(wallet.secretKey),
          type: 'market_maker'
        };
      }
      
      // Сохраняем новый набор в wallet-sets.json
      const walletSet = {
        id: newSetId,
        createdAt: new Date().toISOString(),
        wallets: Object.entries(wallets).map(([number, data]) => ({
          NUMBER: number,
          TYPE: data.type,
          PUBLIC_KEY: data.publicKey,
          PRIVATE_KEY: data.privateKey
        }))
      };
      
      const setsDir = path.join(__dirname, '../../../db');
      if (!fs.existsSync(setsDir)) {
        fs.mkdirSync(setsDir, { recursive: true });
      }
      
      fs.writeFileSync(walletSetsPath, JSON.stringify({ [newSetId]: walletSet }, null, 2));
      console.log(`Created new wallet set with ID: ${newSetId}`);
      
      // Вставляем новый набор в базу данных
      await insertWalletSet(dbService, newSetId, wallets);
    } else {
      // Загружаем существующие наборы
      console.log('Loading existing wallet sets...');
      const data = fs.readFileSync(walletSetsPath, 'utf8');
      const sets = JSON.parse(data) as Record<string, WalletSetData>;
      
      // Обрабатываем каждый набор
      for (const [setId, set] of Object.entries(sets)) {
        console.log(`Processing set ${setId}...`);
        
        // Проверяем, существует ли набор в базе
        const client = await dbService.getClient();
        try {
          const existingSet = await client.query(
            'SELECT COUNT(*) FROM wallets WHERE set_id = $1',
            [setId]
          );
          
          if (parseInt(existingSet.rows[0].count) > 0) {
            console.log(`Set ${setId} already exists in database, skipping.`);
            continue;
          }
          
          // Преобразуем данные в нужный формат
          const wallets: { [key: number]: { publicKey: string, privateKey: string, type: string } } = {};
          set.wallets.forEach(wallet => {
            wallets[parseInt(wallet.NUMBER)] = {
              publicKey: wallet.PUBLIC_KEY,
              privateKey: wallet.PRIVATE_KEY,
              type: wallet.TYPE
            };
          });
          
          // Вставляем набор в базу данных
          await insertWalletSet(dbService, setId, wallets);
        } finally {
          client.release();
        }
      }
    }
    
    console.log('Migration completed successfully.');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

// Вспомогательная функция для вставки набора кошельков
async function insertWalletSet(
  dbService: DatabaseService,
  setId: string,
  wallets: { [key: number]: { publicKey: string, privateKey: string, type: string } }
) {
  const client = await dbService.getClient();
  try {
    await client.query('BEGIN');
    
    for (const [index, wallet] of Object.entries(wallets)) {
      await client.query(
        `INSERT INTO wallets (wallet_number, public_key, private_key, wallet_type, set_id) 
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (public_key, set_id) DO NOTHING`,
        [parseInt(index), wallet.publicKey, wallet.privateKey, wallet.type, setId]
      );
    }
    
    await client.query('COMMIT');
    console.log(`Successfully migrated set ${setId} to the database.`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Error during set ${setId} migration:`, error);
    throw error;
  } finally {
    client.release();
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