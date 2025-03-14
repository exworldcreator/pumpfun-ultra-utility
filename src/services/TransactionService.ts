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

  private async distributeToMarketMakersBatch(
    startIndex: number,
    endIndex: number,
    walletAmounts: { [key: number]: number },
    marketMakingPayer: Keypair,
    progressCallback?: (text: string) => Promise<void>
  ): Promise<string[]> {
    const signatures: string[] = [];
    const BATCH_SIZE = 3;

    console.log(`Начинаем распределение для кошельков ${startIndex}-${endIndex}`);
    console.log(`Баланс кошелька #25 перед распределением: ${await this.connection.getBalance(marketMakingPayer.publicKey) / LAMPORTS_PER_SOL} SOL`);

    for (let i = startIndex; i <= endIndex; i += BATCH_SIZE) {
      const batchPromises = [];
      const currentEndIndex = Math.min(i + BATCH_SIZE - 1, endIndex);
      
      console.log(`\nОбработка пакета кошельков ${i}-${currentEndIndex}:`);

      for (let j = i; j <= currentEndIndex; j++) {
        const targetWallet = this.walletService.getWalletByIndex(j);
        if (!targetWallet) {
          throw new Error(`Target wallet #${j} not found`);
        }

        const actualAmount = walletAmounts[j];
        console.log(`Подготовка транзакции: ${actualAmount / LAMPORTS_PER_SOL} SOL на кошелек #${j}`);
        
        if (progressCallback) {
          await progressCallback(`Отправка ${actualAmount / LAMPORTS_PER_SOL} SOL на кошелек #${j}...`);
        }

        const sendTransaction = async () => {
          console.log(`Начало отправки транзакции на кошелек #${j}`);
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

              const signature = await sendAndConfirmTransaction(
                this.connection,
                transaction,
                [marketMakingPayer],
                confirmOptions
              );
              console.log(`✅ Успешная транзакция на кошелек #${j}: ${signature}`);
              return signature;
            } catch (error) {
              if (error instanceof Error) {
                console.error(`❌ Ошибка при отправке на кошелек #${j}:`, error.message);
                if (error.message.includes('429 Too Many Requests')) {
                  await this.sleep(5000);
                  this.switchToNextRPC();
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

        await this.sleep(500);
        console.log(`Добавление транзакции для кошелька #${j} в пакет`);
        batchPromises.push(sendTransaction());
      }

      try {
        console.log(`\nОжидание выполнения пакета транзакций ${i}-${currentEndIndex}...`);
        const batchSignatures = await Promise.all(batchPromises);
        signatures.push(...batchSignatures);
        console.log(`✅ Пакет ${i}-${currentEndIndex} успешно обработан`);

        if (i + BATCH_SIZE <= endIndex) {
          if (progressCallback) {
            await progressCallback('Делаем паузу между пакетами...');
          }
          console.log(`Пауза 3 секунды перед следующим пакетом`);
          await this.sleep(3000);
        }
      } catch (error) {
        console.error(`❌ Ошибка при обработке пакета ${i}-${currentEndIndex}:`, error);
        throw error;
      }
    }

    console.log(`\nРаспределение для кошельков ${startIndex}-${endIndex} завершено`);
    console.log(`Баланс кошелька #25 после распределения: ${await this.connection.getBalance(marketMakingPayer.publicKey) / LAMPORTS_PER_SOL} SOL`);
    return signatures;
  }

  public async distributeToMarketMakers(
    amount: number,
    useLookupTable: boolean = false,
    progressCallback?: (text: string) => Promise<void>
  ): Promise<string[]> {
    try {
      const marketMakingPayer = this.walletService.getWalletByIndex(25);
      if (!marketMakingPayer) {
        throw new Error('Market making payer wallet (#25) not found');
      }

      // Проверяем баланс кошелька #25
      const payerBalance = await this.connection.getBalance(marketMakingPayer.publicKey);
      const totalAmount = amount * LAMPORTS_PER_SOL;
      
      // Учитываем комиссии за транзакции (примерно 0.000005 SOL за транзакцию)
      const transactionFee = 5000;
      const numberOfTransactions = 75 * 2; // Удваиваем количество транзакций (rent + distribution)
      const totalFees = transactionFee * numberOfTransactions;
      
      // Получаем минимальный баланс для rent-exempt статуса
      const rentExemptBalance = await this.connection.getMinimumBalanceForRentExemption(0);
      const totalRentExempt = rentExemptBalance * 75; // Для всех кошельков
      
      console.log(`Минимальный баланс для rent-exempt: ${rentExemptBalance / LAMPORTS_PER_SOL} SOL`);
      console.log(`Всего нужно для rent-exempt: ${totalRentExempt / LAMPORTS_PER_SOL} SOL`);
      
      // Проверяем, достаточно ли средств для всех транзакций с учетом rent-exempt
      const requiredAmount = totalAmount + totalFees + totalRentExempt;
      
      if (payerBalance < requiredAmount) {
        throw new Error(`Insufficient funds in wallet #25. Required: ${requiredAmount / LAMPORTS_PER_SOL} SOL (including rent-exempt and fees), Available: ${payerBalance / LAMPORTS_PER_SOL} SOL`);
      }

      console.log(`Баланс кошелька #25: ${payerBalance / LAMPORTS_PER_SOL} SOL`);
      console.log(`Необходимо для распределения: ${totalAmount / LAMPORTS_PER_SOL} SOL`);
      console.log(`Комиссии за транзакции: ${totalFees / LAMPORTS_PER_SOL} SOL`);
      console.log(`Необходимо для rent-exempt: ${totalRentExempt / LAMPORTS_PER_SOL} SOL`);
      console.log(`Всего необходимо: ${requiredAmount / LAMPORTS_PER_SOL} SOL`);

      // Рассчитываем базовую сумму на кошелек для распределения (без учета rent-exempt)
      const baseAmountPerWallet = Math.floor(totalAmount / 75);
      
      // Рассчитываем суммы для распределения
      let remainingAmount = totalAmount;
      const walletAmounts: { [key: number]: number } = {};
      const rentAmounts: { [key: number]: number } = {};

      for (let i = 26; i < 100; i++) {
        // Сумма для rent-exempt
        rentAmounts[i] = rentExemptBalance;
        
        // Сумма для распределения
        const randomizedAmount = this.getRandomizedAmount(baseAmountPerWallet);
        walletAmounts[i] = randomizedAmount;
        remainingAmount -= randomizedAmount;
      }
      
      // Последний кошелек
      rentAmounts[100] = rentExemptBalance;
      walletAmounts[100] = remainingAmount;

      // Функция для отправки одной транзакции
      const sendSingleTransaction = async (
        targetWallet: Keypair,
        amount: number,
        description: string
      ): Promise<string> => {
        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: marketMakingPayer.publicKey,
            toPubkey: targetWallet.publicKey,
            lamports: amount
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

            const signature = await sendAndConfirmTransaction(
              this.connection,
              transaction,
              [marketMakingPayer],
              confirmOptions
            );
            console.log(`✅ ${description}: ${signature}`);
            return signature;
          } catch (error) {
            if (error instanceof Error) {
              console.error(`❌ Ошибка при ${description}:`, error.message);
              if (error.message.includes('429 Too Many Requests')) {
                await this.sleep(5000);
                this.switchToNextRPC();
                throw error;
              }
              throw error;
            }
            throw error;
          }
        }, 5, 1000);
      };

      // Модифицируем функцию distributeToMarketMakersBatch
      const distributeToMarketMakersBatch = async (
        startIndex: number,
        endIndex: number
      ): Promise<string[]> => {
        const signatures: string[] = [];
        const BATCH_SIZE = 3;

        console.log(`\nНачинаем распределение для кошельков ${startIndex}-${endIndex}`);

        for (let i = startIndex; i <= endIndex; i += BATCH_SIZE) {
          const batchPromises = [];
          const currentEndIndex = Math.min(i + BATCH_SIZE - 1, endIndex);
          
          for (let j = i; j <= currentEndIndex; j++) {
            const targetWallet = this.walletService.getWalletByIndex(j);
            if (!targetWallet) {
              throw new Error(`Target wallet #${j} not found`);
            }

            // Сначала отправляем rent-exempt
            if (progressCallback) {
              await progressCallback(`Отправка rent-exempt ${rentAmounts[j] / LAMPORTS_PER_SOL} SOL на кошелек #${j}...`);
            }
            const rentSignature = await sendSingleTransaction(
              targetWallet,
              rentAmounts[j],
              `Отправка rent-exempt на кошелек #${j}`
            );
            signatures.push(rentSignature);

            await this.sleep(500);

            // Затем отправляем сумму распределения
            if (progressCallback) {
              await progressCallback(`Отправка ${walletAmounts[j] / LAMPORTS_PER_SOL} SOL на кошелек #${j}...`);
            }
            const distributionSignature = await sendSingleTransaction(
              targetWallet,
              walletAmounts[j],
              `Отправка распределения на кошелек #${j}`
            );
            signatures.push(distributionSignature);
          }

          if (i + BATCH_SIZE <= endIndex) {
            if (progressCallback) {
              await progressCallback('Делаем паузу между пакетами...');
            }
            console.log(`Пауза 3 секунды перед следующим пакетом`);
            await this.sleep(3000);
          }
        }

        return signatures;
      };

      // Распределяем первую часть (26-29)
      if (progressCallback) {
        await progressCallback('Начинаем распределение первой части (кошельки 26-29)...');
      }
      const firstBatchSignatures = await distributeToMarketMakersBatch(26, 29);

      // Делаем длительную паузу перед второй частью
      if (progressCallback) {
        await progressCallback('Делаем длительную паузу перед кошельком #30...');
      }
      await this.sleep(15000);

      // Распределяем вторую часть (30-100)
      if (progressCallback) {
        await progressCallback('Начинаем распределение второй части (кошельки 30-100)...');
      }
      const secondBatchSignatures = await distributeToMarketMakersBatch(30, 100);

      return [...firstBatchSignatures, ...secondBatchSignatures];
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