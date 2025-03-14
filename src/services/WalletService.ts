import { Keypair, PublicKey } from '@solana/web3.js';
import { createObjectCsvWriter } from 'csv-writer';
import * as fs from 'fs';
import * as path from 'path';
import { LookupTableService } from './LookupTableService';
import csvParser from 'csv-parser';

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

export class WalletService {
  private devWallet: Keypair | null = null;
  private devWalletPublicKey: string | null = null;
  private walletsPath: string;
  private wallets: Map<number, Keypair> = new Map();
  private lookupTableService: LookupTableService;

  constructor() {
    this.walletsPath = path.join(__dirname, '../../wallets.json');
    this.lookupTableService = new LookupTableService();
    this.loadWallets();
  }

  private loadWallets() {
    try {
      // Try to load from wallet sets first
      const walletSetsPath = path.join(__dirname, '../../db/wallet-sets.json');
      if (fs.existsSync(walletSetsPath)) {
        const data = fs.readFileSync(walletSetsPath, 'utf8');
        const sets = JSON.parse(data) as Record<string, WalletSetData>;
        
        // Get the most recent set
        const mostRecentSet = Object.values(sets)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        
        if (mostRecentSet && mostRecentSet.wallets) {
          mostRecentSet.wallets.forEach(walletData => {
            const index = parseInt(walletData.NUMBER, 10);
            const secretKey = Buffer.from(walletData.PRIVATE_KEY, 'base64');
            const keypair = Keypair.fromSecretKey(secretKey);
            this.wallets.set(index, keypair);
            
            // If this is dev wallet (index 0), set it
            if (index === 0) {
              this.devWallet = keypair;
            }
          });
          
          console.log(`Loaded ${this.wallets.size} wallets from the most recent wallet set`);
          return;
        }
      }
      
      // Fallback to wallets.json if no wallet sets found
      if (fs.existsSync(this.walletsPath)) {
        const data = fs.readFileSync(this.walletsPath, 'utf8');
        const walletsData: WalletData[] = JSON.parse(data);
        
        walletsData.forEach(walletData => {
          const secretKey = Buffer.from(walletData.privateKey, 'base64');
          const keypair = Keypair.fromSecretKey(secretKey);
          this.wallets.set(walletData.index, keypair);
          
          if (walletData.index === 0) {
            this.devWallet = keypair;
          }
        });
        
        console.log(`Loaded ${this.wallets.size} wallets from JSON`);
      }
    } catch (error) {
      console.error('Error loading wallets:', error);
    }
  }

  private saveWallets() {
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

        console.log('Creating bundle lookup table...');
        // Get bundle wallets (1-23) and bundle payer (24)
        const bundleWallets = wallets.filter(w => w.index >= 1 && w.index <= 24);
        bundleLUT = await this.lookupTableService.createLookupTable(devWalletData, bundleWallets);

        console.log('Creating market making lookup table...');
        // Get market making wallets (26-100) and market making payer (25)
        const marketMakingWallets = wallets.filter(w => w.index >= 25 && w.index <= 100);
        marketMakingLUT = await this.lookupTableService.createLookupTable(devWalletData, marketMakingWallets);
      } catch (err: any) {
        console.error('Error creating lookup tables:', err);
        
        // Check if it's a "no SOL" error
        if (err.message && err.message.includes('debit an account but found no record of a prior credit')) {
          error = `Dev wallet has insufficient SOL to pay for Lookup Table creation. Please fund the dev wallet first.`;
        } else {
          error = 'Failed to create Lookup Tables: ' + err.message;
        }
        // Continue even if LUT creation fails
      }
    }

    return {
      csvFilePath,
      wallets,
      bundleLUT,
      marketMakingLUT,
      error
    };
  }

  /**
   * Gets a wallet by its index
   * @param index The index of the wallet to get (0 for dev wallet)
   * @returns The wallet keypair or null if not found
   */
  async getWallet(index: number): Promise<Keypair | null> {
    const wallet = this.wallets.get(index);
    if (wallet) {
      console.log(`Found wallet ${index} with public key: ${wallet.publicKey.toString()}`);
      return wallet;
    }
    console.error(`Wallet with index ${index} not found`);
    return null;
  }

  public getWalletByIndex(index: number): Keypair | null {
    return this.wallets.get(index) || null;
  }

  public getAllWallets(): Map<number, Keypair> {
    return this.wallets;
  }
} 