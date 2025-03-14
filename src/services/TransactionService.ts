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
  private rpcUrls: string[];
  private currentRpcIndex: number;
  private connection: Connection;
  private walletService: WalletService;
  private walletSetService: WalletSetService;
  private lookupTableService: LookupTableService;
  private bundleLUT: string | null = null;
  private marketMakingLUT: string | null = null;
  
  constructor(
    walletService: WalletService, 
    rpcUrl: string = 'https://api.mainnet-beta.solana.com'
  ) {
    // List of RPC endpoints to use (add your actual endpoints here)
    this.rpcUrls = [
      rpcUrl,
      'https://mainnet.helius-rpc.com/?api-key=3a000b3a-3d3b-4e41-9b30-c75d439068f1',
      'https://solana-mainnet.g.alchemy.com/v2/demo',  // Replace with actual API key
      'https://api.mainnet-beta.solana.com'
    ];
    this.currentRpcIndex = 0;
    this.connection = new Connection(this.rpcUrls[this.currentRpcIndex]);
    this.walletService = walletService;
    this.walletSetService = new WalletSetService();
    this.lookupTableService = new LookupTableService(this.rpcUrls[this.currentRpcIndex]);
  }

  private switchToNextRPC(): void {
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcUrls.length;
    console.log(`Switching to RPC endpoint: ${this.rpcUrls[this.currentRpcIndex]}`);
    this.connection = new Connection(this.rpcUrls[this.currentRpcIndex]);
    this.lookupTableService = new LookupTableService(this.rpcUrls[this.currentRpcIndex]);
  }

  public setLookupTableAddresses(bundleLUT: string, marketMakingLUT: string) {
    this.bundleLUT = bundleLUT;
    this.marketMakingLUT = marketMakingLUT;
  }

  public async getBundlePayerBalance(): Promise<number> {
    try {
      const bundlePayer = this.walletService.getWalletByIndex(24);
      if (!bundlePayer) {
        throw new Error('Bundle payer wallet (#24) not found');
      }
      const balance = await this.connection.getBalance(bundlePayer.publicKey);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      console.error('Error getting bundle payer wallet balance:', error);
      throw error;
    }
  }

  public async getMarketMakingPayerBalance(): Promise<number> {
    try {
      const marketMakingPayer = this.walletService.getWalletByIndex(25);
      if (!marketMakingPayer) {
        throw new Error('Market making payer wallet (#25) not found');
      }
      const balance = await this.connection.getBalance(marketMakingPayer.publicKey);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      console.error('Error getting market making payer wallet balance:', error);
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
    // Перезагружаем кошельки из базы данных или активного сета
    await this.walletService.reloadWallets();
  }

  private getRandomizedAmount(baseAmount: number): number {
    // Generate random variation between -20% and +20%
    const variation = 0.2; // 20%
    const randomFactor = 1 + (Math.random() * variation * 2 - variation);
    return Math.floor(baseAmount * randomFactor);
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
      const baseAmountPerWallet = Math.floor(totalAmount / 23);

      // Calculate total remaining amount to distribute
      let remainingAmount = totalAmount;
      const walletAmounts: { [key: number]: number } = {};

      // First pass: assign randomized amounts to all wallets except the last one
      for (let i = 1; i < 23; i++) {
        const randomizedAmount = this.getRandomizedAmount(baseAmountPerWallet);
        walletAmounts[i] = randomizedAmount;
        remainingAmount -= randomizedAmount;
      }
      // Last wallet gets the remaining amount to ensure total is correct
      walletAmounts[23] = remainingAmount;

      // Process in batches of 5 transactions
      const BATCH_SIZE = 5;
      for (let i = 1; i <= 23; i += BATCH_SIZE) {
        const batchPromises = [];
        const endIndex = Math.min(i + BATCH_SIZE - 1, 23);

        for (let j = i; j <= endIndex; j++) {
          const targetWallet = this.walletService.getWalletByIndex(j);
          if (!targetWallet) {
            throw new Error(`Target wallet #${j} not found`);
          }

          const actualAmount = walletAmounts[j];
          if (progressCallback) {
            await progressCallback(`Отправка ${actualAmount / LAMPORTS_PER_SOL} SOL на кошелек #${j}...`);
          }

          const sendTransaction = async () => {
            const transaction = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: bundlePayer.publicKey,
                toPubkey: targetWallet.publicKey,
                lamports: actualAmount
              })
            );

            return this.retryWithBackoff(async () => {
              try {
                const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
                transaction.recentBlockhash = blockhash;
                transaction.lastValidBlockHeight = lastValidBlockHeight;

                const confirmOptions = {
                  skipPreflight: false,
                  commitment: 'confirmed' as const,
                  preflightCommitment: 'confirmed' as const,
                  maxRetries: 5
                };

                return await sendAndConfirmTransaction(
                  this.connection,
                  transaction,
                  [bundlePayer],
                  confirmOptions
                );
              } catch (error) {
                if (error instanceof Error) {
                  if (error.message.includes('429 Too Many Requests')) {
                    throw error;
                  } else if (error.message.includes('insufficient funds')) {
                    throw new Error(`Insufficient funds in wallet #24 for distribution to wallet #${j}`);
                  } else if (error.message.includes('blockhash not found')) {
                    this.switchToNextRPC();
                    throw error;
                  }
                }
                throw error;
              }
            }, 5, 1000);
          };

          batchPromises.push(sendTransaction());
        }

        try {
          const batchSignatures = await Promise.all(batchPromises);
          signatures.push(...batchSignatures);

          if (i + BATCH_SIZE <= 23) {
            await this.sleep(2000);
          }
        } catch (error) {
          console.error(`Error processing batch ${i}-${endIndex}:`, error);
          throw error;
        }
      }

      return signatures;
    } catch (error) {
      console.error('Error in distributeToBundle:', error);
      throw error;
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 5,
    baseDelay: number = 500
  ): Promise<T> {
    let lastError: Error | unknown;
    let rpcRetries = 0;
    const maxRpcRetries = this.rpcUrls.length;

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation();
      } catch (error: unknown) {
        lastError = error;
        if (error instanceof Error) {
          // If we hit rate limits, try switching RPC endpoints
          if (error.message.includes('429 Too Many Requests')) {
            if (rpcRetries < maxRpcRetries) {
              this.switchToNextRPC();
              rpcRetries++;
              continue;
            }
          }
          // For other errors or if we've tried all RPCs, use exponential backoff
          const delay = baseDelay * Math.pow(2, i);
          await this.sleep(delay);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
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
      const baseAmountPerWallet = Math.floor(totalAmount / 75);

      // Calculate total remaining amount to distribute
      let remainingAmount = totalAmount;
      const walletAmounts: { [key: number]: number } = {};

      // First pass: assign randomized amounts to all wallets except the last one
      for (let i = 26; i < 100; i++) {
        const randomizedAmount = this.getRandomizedAmount(baseAmountPerWallet);
        walletAmounts[i] = randomizedAmount;
        remainingAmount -= randomizedAmount;
      }
      // Last wallet gets the remaining amount to ensure total is correct
      walletAmounts[100] = remainingAmount;

      // Process in batches of 5 transactions
      const BATCH_SIZE = 5;
      for (let i = 26; i <= 100; i += BATCH_SIZE) {
        const batchPromises = [];
        const endIndex = Math.min(i + BATCH_SIZE - 1, 100);

        for (let j = i; j <= endIndex; j++) {
          const targetWallet = this.walletService.getWalletByIndex(j);
          if (!targetWallet) {
            throw new Error(`Target wallet #${j} not found`);
          }

          const actualAmount = walletAmounts[j];
          if (progressCallback) {
            await progressCallback(`Отправка ${actualAmount / LAMPORTS_PER_SOL} SOL на кошелек #${j}...`);
          }

          const sendTransaction = async () => {
            const transaction = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: marketMakingPayer.publicKey,
                toPubkey: targetWallet.publicKey,
                lamports: actualAmount
              })
            );

            return this.retryWithBackoff(async () => {
              try {
                const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
                transaction.recentBlockhash = blockhash;
                transaction.lastValidBlockHeight = lastValidBlockHeight;

                const confirmOptions = {
                  skipPreflight: false,
                  commitment: 'confirmed' as const,
                  preflightCommitment: 'confirmed' as const,
                  maxRetries: 5
                };

                return await sendAndConfirmTransaction(
                  this.connection,
                  transaction,
                  [marketMakingPayer],
                  confirmOptions
                );
              } catch (error) {
                if (error instanceof Error) {
                  if (error.message.includes('429 Too Many Requests')) {
                    throw error;
                  } else if (error.message.includes('insufficient funds')) {
                    throw new Error(`Insufficient funds in wallet #25 for distribution to wallet #${j}`);
                  } else if (error.message.includes('blockhash not found')) {
                    this.switchToNextRPC();
                    throw error;
                  }
                }
                throw error;
              }
            }, 5, 1000);
          };

          batchPromises.push(sendTransaction());
        }

        try {
          const batchSignatures = await Promise.all(batchPromises);
          signatures.push(...batchSignatures);

          if (i + BATCH_SIZE <= 100) {
            await this.sleep(2000);
          }
        } catch (error) {
          console.error(`Error processing batch ${i}-${endIndex}:`, error);
          throw error;
        }
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
      const bundleAddresses = bundleWallets.map(w => new PublicKey(w.publicKey));
      this.bundleLUT = await this.lookupTableService.createLookupTable(
        this.walletService.getDevWallet()!,
        bundleAddresses,
        'bundle'
      );

      console.log('Creating market making lookup table...');
      const marketMakingAddresses = marketMakingWallets.map(w => new PublicKey(w.publicKey));
      this.marketMakingLUT = await this.lookupTableService.createLookupTable(
        this.walletService.getDevWallet()!,
        marketMakingAddresses,
        'market_making'
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