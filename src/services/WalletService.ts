import { Keypair, PublicKey } from '@solana/web3.js';
import { createObjectCsvWriter } from 'csv-writer';
import * as fs from 'fs';
import * as path from 'path';
import { LookupTableService } from './LookupTableService';
import csvParser from 'csv-parser';
import { DatabaseService } from './DatabaseService';

export interface WalletData {
  publicKey: string;
  privateKey: string;
  index: number;
  type: 'dev' | 'bundle' | 'bundle_payer' | 'market_maker' | 'market_maker_payer';
}

export interface WalletGenerationResult {
  csvFilePath: string;
  wallets: WalletData[];
  bundleLUT?: string;
  marketMakingLUT?: string;
  error?: string;
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

interface WalletSetWallet {
  NUMBER: string;
  TYPE: string;
  PUBLIC_KEY: string;
  PRIVATE_KEY: string;
}

interface WalletSet {
  id: string;
  createdAt: Date;
  wallets: WalletSetWallet[];
}

export class WalletService {
  private devWallet: Keypair | null = null;
  private devWalletPublicKey: string | null = null;
  private walletsPath: string;
  private wallets: Map<number, Keypair> = new Map();
  private lookupTableService: LookupTableService;
  private dbService: DatabaseService;
  private useDatabase: boolean = true;
  private activeWalletSetId: string | null = null;

  private constructor() {
    this.walletsPath = path.join(__dirname, '../../wallets.json');
    this.lookupTableService = new LookupTableService();
    this.dbService = DatabaseService.getInstance();
  }

  public static async initialize(): Promise<WalletService> {
    const service = new WalletService();
    await service.loadWallets();
    return service;
  }

  private async loadWallets() {
    try {
      if (this.useDatabase) {
        await this.loadWalletsFromDatabase();
      } else {
        this.loadWalletsFromFiles();
      }
    } catch (error) {
      console.error('Error loading wallets:', error);
      throw error;
    }
  }

  private async loadWalletsFromDatabase() {
    try {
      console.log('Loading wallets from database...');
      
      // Проверяем, существует ли таблица wallets
      const tableExists = await this.dbService.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'wallets'
        );
      `);
      
      if (!tableExists.rows[0].exists) {
        console.log('Wallets table does not exist in the database. Creating it...');
        const sqlFilePath = path.join(__dirname, '../db/migrations/001_create_wallets_table.sql');
        const sqlScript = fs.readFileSync(sqlFilePath, 'utf8');
        await this.dbService.query(sqlScript);
        
        // Если таблица только что создана, инициализируем её данными из файлов
        await this.initializeDatabaseFromFiles();
      }
      
      // Используем 'default' как set_id, если activeWalletSetId не установлен
      const setId = this.activeWalletSetId || 'default';
      console.log(`Loading wallets for set_id: ${setId}`);
      
      // Получаем кошельки из базы данных для активного набора
      let result = await this.dbService.query(
        'SELECT * FROM wallets WHERE set_id = $1 ORDER BY wallet_number',
        [setId]
      );
      
      if (result.rows.length === 0) {
        console.log(`No wallets found in the database for set_id: ${setId}. Initializing from files...`);
        await this.initializeDatabaseFromFiles();
        // Повторно получаем кошельки после инициализации
        result = await this.dbService.query(
          'SELECT * FROM wallets WHERE set_id = $1 ORDER BY wallet_number',
          [setId]
        );
      }
      
      // Загружаем кошельки в память
      this.wallets.clear();
      result.rows.forEach(row => {
        const secretKey = Buffer.from(row.private_key, 'base64');
        const keypair = Keypair.fromSecretKey(secretKey);
        this.wallets.set(row.wallet_number, keypair);
        
        // Если это dev wallet (index 0), устанавливаем его
        if (row.wallet_number === 0) {
          this.devWallet = keypair;
          this.devWalletPublicKey = keypair.publicKey.toString();
        }
      });
      
      console.log(`Loaded ${this.wallets.size} wallets from the database for set_id: ${setId}`);
    } catch (error) {
      console.error('Error loading wallets from database:', error);
      throw error;
    }
  }

  private async initializeDatabaseFromFiles() {
    // Загружаем кошельки из файлов
    this.loadWalletsFromFiles();
    
    // Сохраняем их в базу данных
    const client = await this.dbService.getClient();
    try {
      await client.query('BEGIN');
      
      // Очищаем таблицу перед вставкой
      await client.query('DELETE FROM wallets');
      
      // Используем 'default' как set_id, если activeWalletSetId не установлен
      const setId = this.activeWalletSetId || 'default';
      
      // Вставляем данные в базу данных
      for (const [indexStr, keypair] of this.wallets.entries()) {
        const index = Number(indexStr);
        let type: WalletData['type'];
        if (index === 0) type = 'dev';
        else if (index >= 1 && index <= 23) type = 'bundle';
        else if (index === 24) type = 'bundle_payer';
        else if (index === 25) type = 'market_maker_payer';
        else type = 'market_maker';
        
        await client.query(
          `INSERT INTO wallets (wallet_number, public_key, private_key, wallet_type, set_id) 
           VALUES ($1, $2, $3, $4, $5)`,
          [
            index,
            keypair.publicKey.toString(),
            Buffer.from(keypair.secretKey).toString('base64'),
            type,
            setId
          ]
        );
      }
      
      await client.query('COMMIT');
      console.log('Successfully initialized database from files');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error initializing database from files:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  private loadWalletsFromFiles() {
    try {
      // Try to load dev wallet first
      const devWalletPath = path.join(__dirname, '../../dev-wallet.json');
      if (fs.existsSync(devWalletPath)) {
        const devWalletData = JSON.parse(fs.readFileSync(devWalletPath, 'utf8'));
        const secretKey = Buffer.from(devWalletData.privateKey, 'base64');
        const devKeypair = Keypair.fromSecretKey(secretKey);
        this.devWallet = devKeypair;
        this.devWalletPublicKey = devKeypair.publicKey.toString();
        this.wallets.set(0, devKeypair);
      }

      // Try to load from wallet sets
      const walletSetsPath = path.join(__dirname, '../../db/wallet-sets.json');
      if (fs.existsSync(walletSetsPath)) {
        const data = fs.readFileSync(walletSetsPath, 'utf8');
        const sets = JSON.parse(data) as Record<string, WalletSetData>;
        
        let targetSet: WalletSetData | null = null;

        if (this.activeWalletSetId && sets[this.activeWalletSetId]) {
          // Load the selected wallet set
          targetSet = sets[this.activeWalletSetId];
          console.log(`Loading wallet set ${this.activeWalletSetId}`);
        } else {
          // Get the most recent set if no specific set is selected
          targetSet = Object.values(sets)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
          if (targetSet) {
            this.activeWalletSetId = targetSet.id;
            console.log(`No wallet set selected, using most recent set ${targetSet.id}`);
          }
        }
        
        if (targetSet && targetSet.wallets) {
          // Clear existing wallets except dev wallet
          const devWallet = this.wallets.get(0);
          this.wallets.clear();
          if (devWallet) {
            this.wallets.set(0, devWallet);
          }

          targetSet.wallets.forEach(walletData => {
            const index = parseInt(walletData.NUMBER, 10);
            // Skip dev wallet (index 0) to preserve the original
            if (index !== 0) {
              const secretKey = Buffer.from(walletData.PRIVATE_KEY, 'base64');
              const keypair = Keypair.fromSecretKey(secretKey);
              this.wallets.set(index, keypair);
            }
          });
          
          console.log(`Loaded ${this.wallets.size} wallets from wallet set ${targetSet.id}`);
          return;
        }
      }
      
      // Fallback to wallets.json if no wallet sets found
      if (fs.existsSync(this.walletsPath)) {
        const data = fs.readFileSync(this.walletsPath, 'utf8');
        const walletsData: WalletData[] = JSON.parse(data);
        
        // Keep dev wallet if exists
        const devWallet = this.wallets.get(0);
        this.wallets.clear();
        if (devWallet) {
          this.wallets.set(0, devWallet);
        }

        walletsData.forEach(walletData => {
          // Skip dev wallet to preserve the original
          if (walletData.index !== 0) {
            const secretKey = Buffer.from(walletData.privateKey, 'base64');
            const keypair = Keypair.fromSecretKey(secretKey);
            this.wallets.set(walletData.index, keypair);
          }
        });
        
        console.log(`Loaded ${this.wallets.size} wallets from JSON`);
      }
    } catch (error) {
      console.error('Error loading wallets from files:', error);
      throw error;
    }
  }

  private async saveWallets() {
    try {
      if (this.useDatabase) {
        await this.saveWalletsToDatabase();
      } else {
        this.saveWalletsToFiles();
      }
    } catch (error) {
      console.error('Error saving wallets:', error);
      throw error;
    }
  }

  private async saveWalletsToDatabase() {
    try {
      console.log('Saving wallets to database...');
      
      // Проверяем, существует ли таблица wallets
      const tableExists = await this.dbService.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'wallets'
        );
      `);
      
      if (!tableExists.rows[0].exists) {
        console.log('Wallets table does not exist in the database. Creating it...');
        const sqlFilePath = path.join(__dirname, '../db/migrations/001_create_wallets_table.sql');
        const sqlScript = fs.readFileSync(sqlFilePath, 'utf8');
        await this.dbService.query(sqlScript);
      }
      
      // Используем транзакцию для атомарного обновления
      const client = await this.dbService.getClient();
      try {
        await client.query('BEGIN');
        
        // Используем 'default' как set_id, если activeWalletSetId не установлен
        const setId = this.activeWalletSetId || 'default';
        
        // Очищаем таблицу перед вставкой новых данных для текущего набора
        await client.query('DELETE FROM wallets WHERE set_id = $1', [setId]);
        
        // Вставляем данные в базу данных
        for (const [indexStr, keypair] of this.wallets.entries()) {
          const index = Number(indexStr);
          let type: WalletData['type'];
          if (index === 0) type = 'dev';
          else if (index >= 1 && index <= 23) type = 'bundle';
          else if (index === 24) type = 'bundle_payer';
          else if (index === 25) type = 'market_maker_payer';
          else type = 'market_maker';
          
          await client.query(
            `INSERT INTO wallets (wallet_number, public_key, private_key, wallet_type, set_id) 
             VALUES ($1, $2, $3, $4, $5)`,
            [
              index,
              keypair.publicKey.toString(),
              Buffer.from(keypair.secretKey).toString('base64'),
              type,
              setId
            ]
          );
        }
        
        await client.query('COMMIT');
        console.log(`Saved ${this.wallets.size} wallets to the database with set_id: ${setId}`);
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error during database transaction:', error);
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error saving wallets to database:', error);
      throw error;
    }
  }

  private saveWalletsToFiles() {
    try {
      const walletsData: WalletData[] = [];
      
      this.wallets.forEach((keypair, index) => {
        let type: WalletData['type'];
        if (index === 0) type = 'dev';
        else if (index >= 1 && index <= 23) type = 'bundle';
        else if (index === 24) type = 'bundle_payer';
        else if (index === 25) type = 'market_maker_payer';
        else type = 'market_maker';

        walletsData.push({
          publicKey: keypair.publicKey.toString(),
          privateKey: Buffer.from(keypair.secretKey).toString('base64'),
          index,
          type
        });
      });

      fs.writeFileSync(this.walletsPath, JSON.stringify(walletsData, null, 2));
      console.log(`Saved ${walletsData.length} wallets to JSON`);
    } catch (error) {
      console.error('Error saving wallets to JSON:', error);
      throw error;
    }
  }

  /**
   * Sets the dev wallet to be used for LUT creation
   * @param wallet The dev wallet keypair or public key string
   */
  async setDevWallet(wallet: Keypair | string): Promise<void> {
    if (typeof wallet === 'string') {
      // If a string is provided, store the public key string for reference
      try {
        // Validate that it's a valid public key
        new PublicKey(wallet);
        
        // Store the public key string in a separate property
        this.devWalletPublicKey = wallet;
        this.devWallet = null; // We don't have the keypair
        
        console.log('Dev wallet public key set in WalletService:', wallet);
      } catch (error) {
        console.error('Invalid public key provided to setDevWallet:', error);
        throw new Error('Invalid public key provided');
      }
    } else {
      // If a keypair is provided, use it directly
      this.devWallet = wallet;
      this.devWalletPublicKey = wallet.publicKey.toString();
      
      // Обновляем dev wallet в базе данных, если используем базу данных
      if (this.useDatabase) {
        try {
          await this.dbService.query(
            `UPDATE wallets SET public_key = $1, private_key = $2, updated_at = CURRENT_TIMESTAMP 
             WHERE wallet_number = 0`,
            [
              wallet.publicKey.toString(),
              Buffer.from(wallet.secretKey).toString('base64')
            ]
          );
        } catch (error) {
          console.error('Error updating dev wallet in database:', error);
        }
      }
      
      console.log('Dev wallet set in WalletService:', wallet.publicKey.toString());
    }
  }

  /**
   * Gets the current dev wallet public key
   * @returns The dev wallet public key as a string
   */
  getDevWalletPublicKey(): string | null {
    if (this.devWallet) {
      return this.devWallet.publicKey.toString();
    }
    return this.devWalletPublicKey || null;
  }

  getDevWallet(): Keypair | null {
    return this.devWallet;
  }

  async generateWallets(createLookupTables: boolean = false): Promise<WalletGenerationResult> {
    const wallets: WalletData[] = [];
    
    // First, make sure we have a dev wallet
    if (!this.devWallet) {
      throw new Error('Dev wallet not initialized');
    }
    
    // Add dev wallet to the list
    wallets.push({
      index: 0,
      publicKey: this.devWallet.publicKey.toString(),
      privateKey: Buffer.from(this.devWallet.secretKey).toString('base64'),
      type: 'dev'
    });

    // Generate bundle wallets (1-23)
    for (let i = 1; i <= 23; i++) {
      const wallet = Keypair.generate();
      wallets.push({
        index: i,
        publicKey: wallet.publicKey.toString(),
        privateKey: Buffer.from(wallet.secretKey).toString('base64'),
        type: 'bundle'
      });
    }

    // Generate bundle payer wallet (24)
    const bundlePayerWallet = Keypair.generate();
    wallets.push({
      index: 24,
      publicKey: bundlePayerWallet.publicKey.toString(),
      privateKey: Buffer.from(bundlePayerWallet.secretKey).toString('base64'),
      type: 'bundle_payer'
    });

    // Generate market making payer wallet (25)
    const marketMakingPayerWallet = Keypair.generate();
    wallets.push({
      index: 25,
      publicKey: marketMakingPayerWallet.publicKey.toString(),
      privateKey: Buffer.from(marketMakingPayerWallet.secretKey).toString('base64'),
      type: 'market_maker_payer'
    });

    // Generate market making wallets (26-100)
    for (let i = 26; i < 101; i++) {
      const wallet = Keypair.generate();
      wallets.push({
        index: i,
        publicKey: wallet.publicKey.toString(),
        privateKey: Buffer.from(wallet.secretKey).toString('base64'),
        type: 'market_maker'
      });
    }

    // Save to CSV
    const csvFilePath = path.join(__dirname, '../../wallets.csv');
    const csvWriter = createObjectCsvWriter({
      path: csvFilePath,
      header: [
        { id: 'index', title: 'NUMBER' },
        { id: 'type', title: 'TYPE' },
        { id: 'publicKey', title: 'PUBLIC_KEY' },
        { id: 'privateKey', title: 'PRIVATE_KEY' }
      ]
    });

    await csvWriter.writeRecords(wallets);

    // Create Lookup Tables if requested
    let bundleLUT: string | undefined;
    let marketMakingLUT: string | undefined;
    let error: string | undefined;

    if (createLookupTables) {
      try {
        // Use the dev wallet for LUT creation
        const devWalletData = {
          index: 0,
          publicKey: this.devWallet.publicKey.toString(),
          privateKey: Buffer.from(this.devWallet.secretKey).toString('base64'),
          type: 'dev' as const
        };

        // Create bundle LUT
        const bundleAddresses = wallets
          .filter(w => w.type === 'bundle')
          .map(w => new PublicKey(w.publicKey));
        
        bundleLUT = await this.lookupTableService.createLookupTable(
          this.devWallet,
          bundleAddresses,
          'bundle'
        );

        // Create market making LUT
        const marketMakingAddresses = wallets
          .filter(w => w.type === 'market_maker')
          .map(w => new PublicKey(w.publicKey));
        
        marketMakingLUT = await this.lookupTableService.createLookupTable(
          this.devWallet,
          marketMakingAddresses,
          'market_making'
        );
      } catch (err: any) {
        console.error('Error creating lookup tables:', err);
        error = err.message;
      }
    }

    // Update our internal wallets map
    this.wallets.clear();
    wallets.forEach(walletData => {
      const secretKey = Buffer.from(walletData.privateKey, 'base64');
      const keypair = Keypair.fromSecretKey(secretKey);
      this.wallets.set(walletData.index, keypair);
    });

    // Save to database if using database
    if (this.useDatabase) {
      await this.saveWalletsToDatabase();
    } else {
      this.saveWalletsToFiles();
    }

    return {
      csvFilePath,
      wallets,
      bundleLUT,
      marketMakingLUT,
      error
    };
  }

  async getWallet(index: number): Promise<Keypair | null> {
    // Если кошелек уже загружен в память, возвращаем его
    if (this.wallets.has(index)) {
      return this.wallets.get(index) || null;
    }
    
    // Если используем базу данных, пытаемся загрузить кошелек из базы данных
    if (this.useDatabase) {
      try {
        const result = await this.dbService.query(
          'SELECT * FROM wallets WHERE wallet_number = $1',
          [index]
        );
        
        if (result.rows.length > 0) {
          const row = result.rows[0];
          const secretKey = Buffer.from(row.private_key, 'base64');
          const keypair = Keypair.fromSecretKey(secretKey);
          
          // Кэшируем кошелек в памяти
          this.wallets.set(index, keypair);
          
          return keypair;
        }
      } catch (error) {
        console.error(`Error loading wallet #${index} from database:`, error);
      }
    }
    
    return null;
  }

  public getWalletByIndex(index: number): Keypair | null {
    return this.wallets.get(index) || null;
  }

  public getAllWallets(): Map<number, Keypair> {
    return this.wallets;
  }

  /**
   * Gets a specific wallet set by ID
   * @param setId The ID of the wallet set to retrieve
   * @returns The wallet set data or null if not found
   */
  private getWalletSet(setId: string): WalletSet | null {
    const walletSetsPath = path.join(__dirname, '../../db/wallet-sets.json');
    if (!fs.existsSync(walletSetsPath)) {
      return null;
    }

    const data = fs.readFileSync(walletSetsPath, 'utf8');
    const sets = JSON.parse(data) as Record<string, WalletSet>;
    return sets[setId] || null;
  }

  /**
   * Sets the active wallet set and reloads wallets
   * @param setId The ID of the wallet set to activate
   */
  public async setActiveWalletSet(setId: string): Promise<void> {
    this.activeWalletSetId = setId;
    
    // Get the wallet set data
    const set = this.getWalletSet(setId);
    if (!set || !set.wallets) {
      throw new Error(`Wallet set ${setId} not found or has no wallets`);
    }
    
    // Load all wallets from the set, preserving dev wallet
    await this.loadWallets();
  }

  /**
   * Gets the ID of the currently active wallet set
   * @returns The ID of the active wallet set or 'default' if none is selected
   */
  public getActiveWalletSetId(): string {
    return this.activeWalletSetId || 'default';
  }

  /**
   * Reloads all wallets from the current source (database or files)
   */
  public async reloadWallets(): Promise<void> {
    await this.loadWallets();
  }

  public async selectWalletSet(setName: string): Promise<void> {
    try {
      const walletSets = JSON.parse(fs.readFileSync('./db/wallet-sets.json', 'utf-8'));
      const selectedSet = walletSets[setName];
      
      if (!selectedSet) {
        throw new Error(`Wallet set ${setName} not found`);
      }

      // Load wallets from the selected set
      this.wallets.clear();
      for (const wallet of selectedSet.wallets) {
        const keypair = Keypair.fromSecretKey(
          Buffer.from(wallet.PRIVATE_KEY, 'base64')
        );
        this.wallets.set(parseInt(wallet.NUMBER), keypair);
      }

      console.log(`Successfully loaded wallet set ${setName}`);
    } catch (error) {
      console.error(`Error selecting wallet set ${setName}:`, error);
      throw error;
    }
  }
} 