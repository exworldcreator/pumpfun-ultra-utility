import { 
  Connection, 
  Keypair, 
  LAMPORTS_PER_SOL, 
  PublicKey, 
  SystemProgram, 
  Transaction,
  sendAndConfirmTransaction,
  TransactionInstruction
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import csvParser from 'csv-parser';
import { WalletData } from './WalletService';
import { LookupTableService } from './LookupTableService';
import { WalletSetService } from './WalletSetService';
import { WalletService } from './WalletService';

interface CsvWalletData {
  NUMBER: string;
  TYPE: string;
  PUBLIC_KEY: string;
  PRIVATE_KEY: string;
}

export class TransactionService {
  private connection: Connection;
  private walletService: WalletService;
  private walletSetService: WalletSetService;
  private lookupTableService: LookupTableService;
  private bundleLUT: string | null = null;
  private marketMakingLUT: string | null = null;
  
  constructor(walletService: WalletService, rpcUrl: string = 'https://api.mainnet-beta.solana.com') {
    this.connection = new Connection(rpcUrl);
    this.walletService = walletService;
    this.walletSetService = new WalletSetService();
    this.lookupTableService = new LookupTableService(rpcUrl);
  }

  public setLookupTableAddresses(bundleLUT: string, marketMakingLUT: string) {
    this.bundleLUT = bundleLUT;
    this.marketMakingLUT = marketMakingLUT;
  }

  public async getDevWalletBalance(publicKey: string): Promise<number> {
    try {
      const balance = await this.connection.getBalance(new PublicKey(publicKey));
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      console.error('Error getting dev wallet balance:', error);
      throw error;
    }
  }

  public async getWalletBalance(index: number): Promise<number> {
    try {
      const wallet = this.walletService.getWalletByIndex(index);
      if (!wallet) {
        throw new Error(`Wallet #${index} not found`);
      }
      const balance = await this.connection.getBalance(wallet.publicKey);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      console.error(`Error getting wallet #${index} balance:`, error);
      throw error;
    }
  }

  public async loadWalletsFromSet(): Promise<void> {
    // Wallets are already loaded in WalletService constructor
    console.log('Wallets are already loaded from JSON');
  }

  public async distributeToBundle(
    amount: number,
    progressCallback?: (text: string) => Promise<void>
  ): Promise<string[]> {
    try {
      const signatures: string[] = [];
      const bundlePayer = this.walletService.getWalletByIndex(24);
      
      if (!bundlePayer) {
        throw new Error('Bundle payer wallet (#24) not found');
      }

      const totalAmount = amount * LAMPORTS_PER_SOL;
      const amountPerWallet = Math.floor(totalAmount / 23);

      for (let i = 1; i <= 23; i++) {
        const targetWallet = this.walletService.getWalletByIndex(i);
        if (!targetWallet) {
          throw new Error(`Target wallet #${i} not found`);
        }

        if (progressCallback) {
          await progressCallback(`Отправка ${amount / 23} SOL на кошелек #${i}...`);
        }

        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: bundlePayer.publicKey,
            toPubkey: targetWallet.publicKey,
            lamports: amountPerWallet
          })
        );

        const signature = await sendAndConfirmTransaction(
          this.connection,
          transaction,
          [bundlePayer]
        );

        signatures.push(signature);
      }

      return signatures;
    } catch (error) {
      console.error('Error in distributeToBundle:', error);
      throw error;
    }
  }

  public async distributeToMarketMakers(
    amount: number,
    useLookupTable: boolean = false,
    progressCallback?: (text: string) => Promise<void>
  ): Promise<string[]> {
    try {
      const signatures: string[] = [];
      const marketMakingPayer = this.walletService.getWalletByIndex(25);
      
      if (!marketMakingPayer) {
        throw new Error('Market making payer wallet (#25) not found');
      }

      const totalAmount = amount * LAMPORTS_PER_SOL;
      const amountPerWallet = Math.floor(totalAmount / 75);

      for (let i = 26; i <= 100; i++) {
        const targetWallet = this.walletService.getWalletByIndex(i);
        if (!targetWallet) {
          throw new Error(`Target wallet #${i} not found`);
        }

        if (progressCallback) {
          await progressCallback(`Отправка ${amount / 75} SOL на кошелек #${i}...`);
        }

        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: marketMakingPayer.publicKey,
            toPubkey: targetWallet.publicKey,
            lamports: amountPerWallet
          })
        );

        const signature = await sendAndConfirmTransaction(
          this.connection,
          transaction,
          [marketMakingPayer]
        );

        signatures.push(signature);
      }

      return signatures;
    } catch (error) {
      console.error('Error in distributeToMarketMakers:', error);
      throw error;
    }
  }

  // Create Lookup Tables for bundle and market making wallets
  async createLookupTables(): Promise<{ bundleLUT: string | null, marketMakingLUT: string | null }> {
    const devWallet = this.walletService.getWalletByIndex(0);
    if (!devWallet) {
      throw new Error('Dev wallet (index 0) not found');
    }

    // Convert dev wallet to WalletData
    const devWalletData: WalletData = {
      publicKey: devWallet.publicKey.toString(),
      privateKey: Buffer.from(devWallet.secretKey).toString('base64'),
      index: 0,
      type: 'dev'
    };

    const wallets = this.walletService.getAllWallets();
    
    // Convert bundle wallets to WalletData
    const bundleWallets: WalletData[] = Array.from(wallets.entries())
      .filter(([index]) => index >= 1 && index <= 24)
      .map(([index, keypair]) => ({
        publicKey: keypair.publicKey.toString(),
        privateKey: Buffer.from(keypair.secretKey).toString('base64'),
        index,
        type: index === 24 ? 'bundle_payer' : 'bundle'
      }));

    // Convert market making wallets to WalletData
    const marketMakingWallets: WalletData[] = Array.from(wallets.entries())
      .filter(([index]) => index >= 25 && index <= 100)
      .map(([index, keypair]) => ({
        publicKey: keypair.publicKey.toString(),
        privateKey: Buffer.from(keypair.secretKey).toString('base64'),
        index,
        type: index === 25 ? 'market_maker_payer' : 'market_maker'
      }));

    if (bundleWallets.length !== 24) {
      throw new Error(`Expected 24 bundle wallets (including payer), found ${bundleWallets.length}`);
    }

    if (marketMakingWallets.length !== 76) {
      throw new Error(`Expected 76 market making wallets (including payer), found ${marketMakingWallets.length}`);
    }

    try {
      // Create Lookup Tables
      console.log('Creating bundle lookup table...');
      this.bundleLUT = await this.lookupTableService.createLookupTable(
        devWalletData,
        bundleWallets
      );

      console.log('Creating market making lookup table...');
      this.marketMakingLUT = await this.lookupTableService.createLookupTable(
        devWalletData,
        marketMakingWallets
      );

      return {
        bundleLUT: this.bundleLUT,
        marketMakingLUT: this.marketMakingLUT
      };
    } catch (error) {
      console.error('Error creating lookup tables:', error);
      throw error;
    }
  }

  // Get lookup table addresses
  getLookupTableAddresses(): { bundleLUT: string | null, marketMakingLUT: string | null } {
    console.log('Getting LUT addresses:', {
      bundleLUT: this.bundleLUT,
      marketMakingLUT: this.marketMakingLUT
    });
    return {
      bundleLUT: this.bundleLUT,
      marketMakingLUT: this.marketMakingLUT
    };
  }

  // Get addresses in a lookup table
  async getAddressesInLookupTable(lookupTableAddress: string): Promise<string[]> {
    try {
      console.log('Getting addresses for LUT:', lookupTableAddress);
      const addresses = await this.lookupTableService.getLookupTableAddresses(lookupTableAddress);
      console.log(`Found ${addresses.length} addresses in LUT`);
      return addresses;
    } catch (error) {
      console.error('Error getting addresses from LUT:', error);
      throw error;
    }
  }
} 