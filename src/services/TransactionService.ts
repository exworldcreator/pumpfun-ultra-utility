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

export interface DistributionState {
  lastProcessedWallet: number;
  remainingAmount: number;
  baseAmount: number;
  failedAttempts: number;
  userId?: string;
  timestamp?: number;
}

export interface IDistributionStateRepository {
  saveState(state: DistributionState): Promise<void>;
  getState(userId: string): Promise<DistributionState | null>;
  deleteState(userId: string): Promise<void>;
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
  private distributionState: DistributionState | null = null;
  private stateRepository: IDistributionStateRepository;
  
  constructor(
    walletService: WalletService,
    stateRepository: IDistributionStateRepository,
    rpcUrl: string = 'https://api.mainnet-beta.solana.com'
  ) {
    this.stateRepository = stateRepository;
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
    const oldRpc = this.rpcUrls[this.currentRpcIndex];
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcUrls.length;
    const newRpc = this.rpcUrls[this.currentRpcIndex];
    
    console.log(`🔄 Переключение RPC:`);
    console.log(`   ❌ Старый: ${oldRpc}`);
    console.log(`   ✅ Новый: ${newRpc}`);
    
    this.connection = new Connection(newRpc);
    this.lookupTableService = new LookupTableService(newRpc);
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
            }, 5);
          };

          batchPromises.push(sendTransaction());
        }

        try {
          const batchSignatures = await Promise.all(batchPromises);
          signatures.push(...batchSignatures);

          if (i + BATCH_SIZE <= 23) {
            await this.sleep(500);
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

  private async sendTransaction(
    fromWallet: Keypair,
    toPublicKey: PublicKey,
    amount: number
  ): Promise<string> {
    console.log(`🔄 Подготовка транзакции: ${amount} SOL с ${fromWallet.publicKey.toString().slice(0, 8)}... на ${toPublicKey.toString().slice(0, 8)}...`);
    
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromWallet.publicKey,
        toPubkey: toPublicKey,
        lamports: Math.floor(amount * LAMPORTS_PER_SOL)
      })
    );

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;

    const confirmOptions = {
      skipPreflight: false,
      commitment: 'confirmed' as const,
      preflightCommitment: 'confirmed' as const,
      maxRetries: 5
    };

    console.log(`📡 Отправка транзакции через RPC: ${this.rpcUrls[this.currentRpcIndex]}`);
    
    // Устанавливаем таймаут для транзакции
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Transaction timeout after 3 seconds')), 3000);
    });

    try {
      // Используем Promise.race для ограничения времени ожидания
      const signature = await Promise.race([
        sendAndConfirmTransaction(
          this.connection,
          transaction,
          [fromWallet],
          confirmOptions
        ),
        timeoutPromise
      ]) as string;
      
      console.log(`✅ Транзакция успешно отправлена: ${signature.slice(0, 12)}...`);
      return signature;
    } catch (error) {
      if (error instanceof Error && error.message.includes('timeout')) {
        console.log(`⏱️ Превышено время ожидания (3 сек). Переключаемся на другой RPC...`);
        this.switchToNextRPC();
        throw error;
      }
      throw error;
    }
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 5
  ): Promise<T> {
    let lastError: Error | unknown;
    let attemptCount = 0;

    for (let i = 0; i < maxRetries; i++) {
      attemptCount++;
      console.log(`🔄 Попытка #${attemptCount} из ${maxRetries}...`);
      
      try {
        const result = await operation();
        console.log(`✅ Операция успешно выполнена с ${attemptCount} попытки`);
        return result;
      } catch (error: unknown) {
        lastError = error;
        if (error instanceof Error) {
          // Логируем ошибку
          console.error(`❌ Ошибка при выполнении операции (попытка ${attemptCount}): ${error.message}`);
          
          // При любой ошибке RPC или таймауте сразу переключаемся
          if (error.message.includes('429 Too Many Requests') || 
              error.message.includes('blockhash not found') ||
              error.message.includes('failed to get recent blockhash') ||
              error.message.includes('failed to send transaction') ||
              error.message.includes('timeout')) {
            console.log(`🔄 Переключение на следующий RPC из-за ошибки: ${error.message.slice(0, 50)}...`);
            this.switchToNextRPC();
            continue; // Сразу пробуем следующий RPC без задержки
          }
          
          if (error.message.includes('insufficient funds') || 
              error.message.includes('insufficient funds for rent')) {
            console.error(`💰 Недостаточно средств, прекращаем попытки`);
            throw error; // Не ретраим ошибки с балансом
          }

          // Для других ошибок делаем минимальную паузу
          console.log(`⏱️ Пауза 100мс перед следующей попыткой...`);
          await this.sleep(100);
          continue;
        }
        throw error;
      }
    }
    console.error(`❌ Все ${maxRetries} попыток завершились неудачно`);
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
    const BATCH_SIZE = 5;

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
                  await this.sleep(1000);
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
          });
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
          await this.sleep(1000);
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
    userId: string,
    useLookupTable: boolean = false,
    progressCallback?: (text: string) => Promise<void>
  ): Promise<string[]> {
    console.log(`\n🚀 Начинаем распределение ${amount} SOL для пользователя ${userId}`);
    
    // Загружаем состояние для пользователя
    await this.loadDistributionState(userId);
    if (this.distributionState) {
      console.log(`📋 Загружено сохраненное состояние: последний кошелек #${this.distributionState.lastProcessedWallet}, осталось ${this.distributionState.remainingAmount} SOL`);
    } else {
      console.log(`📋 Сохраненное состояние не найдено, начинаем с начала`);
    }

    const signatures: string[] = [];
    const marketMakingPayer = await this.walletService.getWallet(25);
    if (!marketMakingPayer) {
      throw new Error('Market making payer wallet not found');
    }

    console.log(`💰 Баланс кошелька #25: ${await this.connection.getBalance(marketMakingPayer.publicKey) / LAMPORTS_PER_SOL} SOL`);

    // Если есть сохраненное состояние, используем его
    if (this.distributionState) {
      await progressCallback?.(`📝 Продолжаем распределение с кошелька #${this.distributionState.lastProcessedWallet}`);
    } else {
      // Инициализируем новое состояние
      const baseAmount = amount / 75; // 75 кошельков (26-100)
      this.distributionState = {
        lastProcessedWallet: 25, // Начинаем с 26
        remainingAmount: amount,
        baseAmount,
        failedAttempts: 0
      };
      console.log(`💵 Базовая сумма на кошелек: ${baseAmount.toFixed(6)} SOL`);
    }

    try {
      // Проверяем, что состояние существует
      if (!this.distributionState) {
        throw new Error('Distribution state not initialized');
      }

      // Обрабатываем кошельки пакетами для ускорения
      const BATCH_SIZE = 5; // Обрабатываем по 5 кошельков параллельно
      console.log(`📦 Размер пакета: ${BATCH_SIZE} кошельков`);
      
      for (let batchStart = this.distributionState.lastProcessedWallet + 1; batchStart <= 100; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, 100);
        console.log(`\n📦 Обработка пакета кошельков #${batchStart}-${batchEnd}`);
        
        // Подготавливаем массив промисов для параллельной обработки
        const batchPromises = [];
        const batchWallets = [];
        
        // Собираем информацию о кошельках для этого пакета
        for (let i = batchStart; i <= batchEnd; i++) {
          const targetWallet = await this.walletService.getWallet(i);
          if (!targetWallet) {
            console.log(`⚠️ Кошелек #${i} не найден, пропускаем`);
            continue;
          }
          
          batchWallets.push({
            index: i,
            wallet: targetWallet
          });
        }
        
        console.log(`👛 Найдено ${batchWallets.length} кошельков для обработки в текущем пакете`);
        
        // Отображаем информацию о текущем пакете
        const totalWallets = 75; // Всего кошельков (26-100)
        const processedWallets = batchStart - 26; // Обработано кошельков до текущего пакета
        const progressPercent = Math.floor((processedWallets / totalWallets) * 100);
        
        await progressCallback?.(`📝 Обработка пакета кошельков #${batchStart}-${batchEnd} | Прогресс: ${progressPercent}%`);
        
        // Создаем промисы для каждого кошелька в пакете
        for (const { index, wallet } of batchWallets) {
          const processWallet = async () => {
            try {
              // Проверяем состояние перед каждой транзакцией
              if (!this.distributionState) {
                throw new Error('Distribution state lost during execution');
              }
              
              // Отображаем информацию о текущей транзакции
              const amountStr = this.distributionState?.baseAmount.toFixed(4) || '0';
              console.log(`💸 Отправка ${amountStr} SOL на кошелек #${index}...`);
              await progressCallback?.(`📝 Отправка ${amountStr} SOL на кошелек #${index}...`);
              
              const signature = await this.retryWithBackoff(async () => {
                if (!this.distributionState) {
                  throw new Error('Distribution state lost during execution');
                }
                return await this.sendTransaction(
                  marketMakingPayer,
                  wallet.publicKey,
                  this.distributionState.baseAmount
                );
              }, 3);
              
              console.log(`✅ Успешно отправлено ${amountStr} SOL на кошелек #${index}`);
              return { index, signature, success: true };
            } catch (error) {
              console.error(`❌ Ошибка при обработке кошелька #${index}:`, error);
              return { index, error, success: false };
            }
          };
          
          batchPromises.push(processWallet());
        }
        
        // Ожидаем завершения всех транзакций в пакете
        console.log(`⏳ Ожидание завершения всех транзакций в пакете...`);
        const results = await Promise.all(batchPromises);
        
        // Обрабатываем результаты
        let successCount = 0;
        let failCount = 0;
        
        for (const result of results) {
          // Проверяем состояние перед обновлением
          if (!this.distributionState) {
            throw new Error('Distribution state lost during execution');
          }
          
          if (result.success) {
            successCount++;
            if (result.signature) {
              signatures.push(result.signature);
            }
            this.distributionState.remainingAmount -= this.distributionState.baseAmount;
            this.distributionState.lastProcessedWallet = result.index;
            this.distributionState.failedAttempts = 0;
          } else if (result.error instanceof Error && result.error.message.includes('TimeoutError')) {
            failCount++;
            this.distributionState.failedAttempts++;
            throw new Error(`TimeoutError at wallet #${result.index}`);
          } else {
            failCount++;
            await progressCallback?.(`⚠️ Ошибка при обработке кошелька #${result.index}, пропускаем...`);
          }
        }
        
        console.log(`📊 Результаты пакета: успешно ${successCount}, ошибок ${failCount}`);
        
        // Сохраняем состояние после каждого пакета
        console.log(`💾 Сохранение состояния распределения...`);
        await this.saveDistributionState(userId);
        
        // Делаем небольшую паузу между пакетами
        console.log(`⏱️ Пауза 1 секунда перед следующим пакетом...`);
        await this.sleep(1000);
      }

      // Успешное завершение - очищаем состояние
      console.log(`🎉 Распределение успешно завершено! Всего отправлено ${signatures.length} транзакций`);
      await this.clearDistributionState(userId);
      return signatures;

    } catch (error) {
      // Сохраняем состояние при ошибке
      console.error(`❌ Ошибка при распределении:`, error);
      await this.saveDistributionState(userId);
      // Проверяем состояние перед отправкой сообщения об ошибке
      if (this.distributionState && error instanceof Error && error.message.includes('TimeoutError')) {
        const message = `⚠️ Превышено время ожидания на кошельке #${this.distributionState.lastProcessedWallet + 1}\n\n` +
          `💰 Осталось распределить: ${this.distributionState.remainingAmount.toFixed(4)} SOL\n` +
          `📝 Нажмите "Продолжить" для возобновления с кошелька #${this.distributionState.lastProcessedWallet + 1}`;
        
        console.log(message);
        await progressCallback?.(message);
      }
      throw error;
    }
  }

  // Метод для проверки наличия сохраненного состояния
  hasUnfinishedDistribution(): boolean {
    return this.distributionState !== null;
  }

  // Метод для получения информации о сохраненном состоянии
  getDistributionState(): DistributionState | null {
    return this.distributionState;
  }

  // Метод для сброса состояния
  resetDistributionState(): void {
    this.distributionState = null;
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

  private async saveDistributionState(userId: string): Promise<void> {
    if (this.distributionState) {
      this.distributionState.userId = userId;
      this.distributionState.timestamp = Date.now();
      await this.stateRepository.saveState(this.distributionState);
    }
  }

  private async loadDistributionState(userId: string): Promise<void> {
    this.distributionState = await this.stateRepository.getState(userId);
  }

  private async clearDistributionState(userId: string): Promise<void> {
    await this.stateRepository.deleteState(userId);
    this.distributionState = null;
  }
} 