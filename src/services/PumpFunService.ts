import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import { Buffer } from 'buffer';
import PinataSDK from '@pinata/sdk';
import { Readable } from 'stream';
import { WalletService } from './WalletService';
import { Metaplex } from '@metaplex-foundation/js';

// Константы программы Pump.fun
const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const GLOBAL_PDA = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

// Константы для размеров буферов
const MAX_NAME_LENGTH = 32;
const MAX_SYMBOL_LENGTH = 8;
const MAX_URI_LENGTH = 200;

// Pinata клиент
const pinata = new PinataSDK(
  '462467ae45c4dc9e8576',
  '90589db9ca22b4d3d29d98803c0aa911e397a017a85e1fe0aa62596fa277c63f'
);

// Интерфейс для результата
export interface TokenCreationResult {
  signature: string;
  mintAddress: string;
  exists: boolean;
  signatureValid: boolean;
  metadataUri: string;
  solscanUrl: string;
  createdAt: Date;
}

export interface TokenCreationParams {
  name: string;
  symbol: string;
  description: string;
  image: Buffer;
  twitter?: string;
  telegram?: string;
  website?: string;
  walletNumber?: number;
}

export interface TokenCreationWithBuyResult extends TokenCreationResult {
  buySignature?: string;
  buyAmount?: number;
}

export class PumpFunService {
  private readonly rpcEndpoints = [
    'https://mainnet.helius-rpc.com/?api-key=7f8f12d7-e70d-4d5f-a2c4-edfa78c89c7f'
  ];
  private connection: Connection;
  private walletService: WalletService;
  public readonly MIN_SOL_BALANCE = 0.015;
  private metaplex: Metaplex;

  constructor(walletService: WalletService, rpcUrl?: string) {
    this.walletService = walletService;
    this.connection = new Connection(rpcUrl || this.rpcEndpoints[0]);
    this.metaplex = new Metaplex(this.connection);
  }

  /**
   * Переподключается к RPC при ошибках
   */
  private switchRpc(): void {
    console.log('Переподключение к Helius RPC...');
    this.connection = new Connection(this.rpcEndpoints[0]);
    this.metaplex = new Metaplex(this.connection);
  }

  /**
   * Выполняет запрос с автоматическими повторами при ошибке
   * @param action Функция, выполняющая запрос
   * @returns Результат запроса
   */
  private async executeWithRpcFailover<T>(action: () => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    const baseDelay = 1000; // 1 секунда
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await action();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Если это последняя попытка, пробрасываем ошибку
        if (attempt === maxAttempts - 1) {
          throw error;
        }
        
        // Проверяем на ошибку 429
        if (errorMessage.includes('429') || errorMessage.includes('Too Many Requests')) {
          const delay = baseDelay * Math.pow(2, attempt); // Экспоненциальная задержка
          console.log(`RPC rate limit exceeded (429). Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          this.switchRpc(); // Переподключаемся к RPC
          continue;
        }
        
        throw error;
      }
    }
    
    throw new Error('Failed to execute after maximum retries');
  }

  // Модифицируем существующие методы для использования executeWithRpcFailover
  async getBalance(publicKey: PublicKey): Promise<number> {
    return this.executeWithRpcFailover(() => this.connection.getBalance(publicKey));
  }

  async getTokenAccountBalance(account: PublicKey): Promise<any> {
    return this.executeWithRpcFailover(() => this.connection.getTokenAccountBalance(account));
  }

  async sendAndConfirmTransaction(
    transaction: Transaction,
    signers: Keypair[],
    options?: any
  ): Promise<string> {
    return this.executeWithRpcFailover(() => 
      sendAndConfirmTransaction(this.connection, transaction, signers, options)
    );
  }

  /**
   * Устанавливает кошелек для создания токена
   * @param walletNumber Номер кошелька (0 для dev wallet)
   */
  async setWalletForTokenCreation(walletNumber: number): Promise<Keypair | null> {
    const wallet = await this.walletService.getWallet(walletNumber);
    if (!wallet) {
      throw new Error(`Wallet #${walletNumber} not found`);
    }
    return wallet;
  }

  /**
   * Загружает файл в IPFS через Pinata
   * @param buffer Буфер с данными
   * @param name Имя файла
   * @returns URI загруженного файла
   */
  private async uploadToPinata(buffer: Buffer, name: string): Promise<string> {
    try {
      const stream = Readable.from(buffer);
      const result = await pinata.pinFileToIPFS(stream, {
        pinataMetadata: { name },
      });
      return `https://ipfs.io/ipfs/${result.IpfsHash}`;
    } catch (error) {
      console.error('Error uploading to Pinata:', error);
      throw error;
    }
  }

  /**
   * Проверяет метаданные токена после создания
   */
  private async verifyMetadata(mintPubkey: PublicKey): Promise<boolean> {
    try {
      const nft = await this.metaplex.nfts().findByMint({ mintAddress: mintPubkey });
      console.log('Token metadata after creation:', {
        name: nft.name,
        symbol: nft.symbol,
        uri: nft.uri,
        sellerFeeBasisPoints: nft.sellerFeeBasisPoints,
        creators: nft.creators,
      });
      return true;
    } catch (error) {
      console.error('Failed to verify metadata:', error);
      return false;
    }
  }

  /**
   * Создаёт новый токен и bonding curve в программе Pump.fun
   * @param name Название токена
   * @param symbol Символ токена
   * @param description Описание токена
   * @param image Изображение токена (Buffer)
   * @param twitter Twitter аккаунт (опционально)
   * @param telegram Telegram аккаунт (опционально)
   * @param website Веб-сайт (опционально)
   * @returns Результат создания токена
   */
  async createToken(
    name: string,
    symbol: string,
    description: string,
    image?: Buffer,
    twitter?: string,
    telegram?: string,
    website?: string
  ): Promise<TokenCreationResult> {
    // Проверяем обязательные поля
    if (!name || name.trim().length === 0) {
      throw new Error('Name is required');
    }
    if (!symbol || symbol.trim().length === 0) {
      throw new Error('Symbol is required');
    }
    if (!description || description.trim().length === 0) {
      throw new Error('Description is required');
    }

    const payer = this.walletService.getDevWallet();
    if (!payer) {
      throw new Error('Dev wallet not found. Please initialize it first.');
    }

    // Проверяем баланс кошелька
    const balance = await this.connection.getBalance(payer.publicKey);
    const solBalance = balance / LAMPORTS_PER_SOL;
    
    if (solBalance < this.MIN_SOL_BALANCE) {
      throw new Error(`Insufficient SOL balance. Required minimum ${this.MIN_SOL_BALANCE} SOL, but got ${solBalance.toFixed(4)} SOL`);
    }

    // 1. Загружаем метаданные в IPFS через Pinata
    const metadata = {
      name: name.trim(),
      symbol: symbol.trim().toUpperCase(), // Символ всегда в верхнем регистре
      description: description.trim(),
      image: undefined as string | undefined,
      seller_fee_basis_points: 0, // Добавляем поле для метаданных
      properties: {
        twitter: twitter?.trim(),
        telegram: telegram?.trim(),
        website: website?.trim(),
        creators: [
          {
            address: payer.publicKey.toBase58(),
            verified: true,
            share: 100
          }
        ]
      }
    };

    try {
      // Загружаем изображение, если оно есть
      if (image) {
        const imageUri = await this.uploadToPinata(image, `${symbol.trim()}_image.jpg`);
        metadata.image = imageUri;
        console.log('Image uploaded to Pinata:', imageUri);
      } else {
        throw new Error('Image is required for token creation');
      }

      // Логируем метаданные перед загрузкой
      console.log('Metadata being uploaded:', JSON.stringify(metadata, null, 2));

      // Загружаем метаданные
      const metadataBuffer = Buffer.from(JSON.stringify(metadata));
      const metadataUri = await this.uploadToPinata(metadataBuffer, `${symbol.trim()}_metadata.json`);
      console.log('Metadata uploaded to Pinata:', metadataUri);

      // Проверяем доступность метаданных
      try {
        const response = await fetch(metadataUri);
        const fetchedMetadata = await response.json();
        console.log('Fetched metadata from URI:', fetchedMetadata);
      } catch (error) {
        console.error('Failed to fetch metadata from URI:', error);
      }

      // Проверяем что URI не пустой
      if (!metadataUri || metadataUri.trim().length === 0) {
        throw new Error('Failed to generate metadata URI');
      }

      // 2. Генерируем новый mint для токена
      const mintKeypair = Keypair.generate();
      const mintPubkey = mintKeypair.publicKey;

      // 3. Вычисляем PDA для mint_authority
      const [mintAuthorityPDA] = await PublicKey.findProgramAddress(
        [Buffer.from('mint-authority')],
        PUMP_FUN_PROGRAM_ID
      );

      // 4. Вычисляем PDA для bondingCurve
      const [bondingCurvePDA] = await PublicKey.findProgramAddress(
        [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
        PUMP_FUN_PROGRAM_ID
      );

      // 5. Вычисляем адрес Associated Token Account для bonding curve
      const associatedBondingCurve = await getAssociatedTokenAddress(
        mintPubkey,
        bondingCurvePDA,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      // 6. Вычисляем PDA для global
      const [globalPDA] = await PublicKey.findProgramAddress(
        [Buffer.from('global')],
        PUMP_FUN_PROGRAM_ID
      );

      // 7. Вычисляем адрес метаданных (Metaplex)
      const [metadataPDA] = await PublicKey.findProgramAddress(
        [
          Buffer.from('metadata'),
          METAPLEX_PROGRAM_ID.toBuffer(),
          mintPubkey.toBuffer(),
        ],
        METAPLEX_PROGRAM_ID
      );

      // 8. Формируем данные инструкции "create" в точном соответствии с IDL
      const createDiscriminator = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);

      // Сериализуем строки напрямую
      const nameBuffer = Buffer.from(name.trim());
      const nameLength = Buffer.alloc(4);
      nameLength.writeUInt32LE(nameBuffer.length);

      const symbolBuffer = Buffer.from(symbol.trim().toUpperCase());
      const symbolLength = Buffer.alloc(4);
      symbolLength.writeUInt32LE(symbolBuffer.length);

      const uriBuffer = Buffer.from(metadataUri);
      const uriLength = Buffer.alloc(4);
      uriLength.writeUInt32LE(uriBuffer.length);

      // Собираем данные в точном соответствии с IDL
      const data = Buffer.concat([
        createDiscriminator,    // 8 байт - дискриминатор инструкции
        nameLength,            // 4 байта - длина имени
        nameBuffer,            // n байт - имя
        symbolLength,          // 4 байта - длина символа
        symbolBuffer,          // n байт - символ
        uriLength,             // 4 байта - длина URI
        uriBuffer,             // n байт - URI
        payer.publicKey.toBuffer() // 32 байта - creator
      ]);

      // Подробное логирование для отладки
      console.log('Instruction Data Details:');
      console.log('Name:', name.trim());
      console.log('Symbol:', symbol.trim().toUpperCase());
      console.log('URI:', metadataUri);
      console.log('Creator:', payer.publicKey.toBase58());
      console.log('Total data length:', data.length);

      // Проверяем содержимое буфера
      const offset = 8; // пропускаем дискриминатор
      const nameLen = data.readUInt32LE(offset);
      const nameStr = data.slice(offset + 4, offset + 4 + nameLen).toString();
      const symbolOffset = offset + 4 + nameLen;
      const symbolLen = data.readUInt32LE(symbolOffset);
      const symbolStr = data.slice(symbolOffset + 4, symbolOffset + 4 + symbolLen).toString();
      const uriOffset = symbolOffset + 4 + symbolLen;
      const uriLen = data.readUInt32LE(uriOffset);
      const uriStr = data.slice(uriOffset + 4, uriOffset + 4 + uriLen).toString();

      console.log('Verified buffer contents:');
      console.log('Name from buffer:', nameStr);
      console.log('Symbol from buffer:', symbolStr);
      console.log('URI from buffer:', uriStr);

      // 9. Создаём инструкцию "create"
      const createInstruction = new TransactionInstruction({
        programId: PUMP_FUN_PROGRAM_ID,
        keys: [
          { pubkey: mintPubkey, isSigner: true, isWritable: true },
          { pubkey: mintAuthorityPDA, isSigner: false, isWritable: false },
          { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
          { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
          { pubkey: globalPDA, isSigner: false, isWritable: false },
          { pubkey: METAPLEX_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: metadataPDA, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
          { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });

      // 10. Создаём и отправляем транзакцию
      const transaction = new Transaction();
      transaction.add(createInstruction);

      const signature = await this.sendAndConfirmTransaction(
        transaction,
        [payer, mintKeypair],
        { commitment: 'confirmed' }
      );

      console.log(`Token created successfully! Mint: ${mintPubkey.toBase58()}`);
      console.log(`Transaction signature: ${signature}`);
      console.log(`Explorer: https://solscan.io/tx/${signature}`);

      // Проверяем метаданные после создания
      await new Promise(resolve => setTimeout(resolve, 2000)); // Ждем 2 секунды для обновления
      const metadataVerified = await this.verifyMetadata(mintPubkey);

      return {
        signature,
        mintAddress: mintPubkey.toBase58(),
        exists: metadataVerified,
        signatureValid: true,
        metadataUri,
        solscanUrl: `https://solscan.io/tx/${signature}`,
        createdAt: new Date(),
      };
    } catch (error) {
      console.error('Error in token creation:', error);
      throw error;
    }
  }

  // Добавляем функцию проверки fee recipient
  private async getFeeRecipient(): Promise<PublicKey> {
    const [globalPda] = await PublicKey.findProgramAddress(
      [Buffer.from('global')],
      PUMP_FUN_PROGRAM_ID
    );
    const accountInfo = await this.connection.getAccountInfo(globalPda);
    if (!accountInfo) throw new Error('Global account not found');
    
    const data = accountInfo.data;
    const feeRecipientOffset = 8 + 32; // Пропускаем initialized (1) и authority (32)
    const feeRecipientBytes = data.slice(feeRecipientOffset, feeRecipientOffset + 32);
    return new PublicKey(feeRecipientBytes);
  }

  /**
   * Покупает токены через bonding curve
   * @param mint Адрес токена
   * @param amountInSol Сумма в SOL для покупки
   * @param minTokenAmount Минимальное количество токенов, которое нужно получить
   * @param payer Кошелёк, оплачивающий транзакцию
   * @returns Подпись транзакции
   */
  async buyTokens(
    mint: PublicKey,
    amountInSol: number,
    minTokenAmount: number,
    payer: Keypair
  ): Promise<string> {
    try {
      const feeRecipient = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
      console.log('Using fee recipient:', feeRecipient.toBase58());

      // Get bonding curve PDA
      const [bondingCurvePublicKey] = await PublicKey.findProgramAddress(
        [Buffer.from("bonding-curve"), mint.toBuffer()],
        PUMP_FUN_PROGRAM_ID
      );

      // Get bonding curve data to calculate price
      const bondingCurveInfo = await this.connection.getAccountInfo(bondingCurvePublicKey);
      if (!bondingCurveInfo) throw new Error('Bonding curve not found');

      // Десериализуем данные bonding curve
      const bondingCurveData = bondingCurveInfo.data;
      const virtualTokenReserves = bondingCurveData.readBigUInt64LE(8);  // Skip discriminator
      const virtualSolReserves = bondingCurveData.readBigUInt64LE(16);   

      // Конвертируем все значения в lamports для точности
      const tokenDecimals = 6;
      // Вычитаем комиссию за транзакцию из суммы покупки
      const txFee = 5000; // 0.000005 SOL
      const amountInLamports = BigInt(Math.floor(amountInSol * LAMPORTS_PER_SOL)) - BigInt(txFee);
      
      // Используем BigInt для точных вычислений
      const x = virtualSolReserves;
      const y = virtualTokenReserves;
      const deltaX = amountInLamports;

      console.log('Initial values:', {
        virtualTokenReserves: virtualTokenReserves.toString(),
        virtualSolReserves: virtualSolReserves.toString(),
        amountInLamports: amountInLamports.toString(),
        amountInSol,
        txFee: txFee / LAMPORTS_PER_SOL
      });
      
      // Используем промежуточные значения с плавающей точкой для большей точности
      const xFloat = Number(x) / LAMPORTS_PER_SOL;
      const yFloat = Number(y) / Math.pow(10, tokenDecimals);
      const deltaXFloat = Number(deltaX) / LAMPORTS_PER_SOL;
      
      // Рассчитываем ожидаемое количество токенов по формуле bonding curve
      // Formula: deltaY = y * ((1 + deltaX/x)^0.5 - 1)
      const ratio = deltaXFloat / xFloat;
      const sqrtTerm = Math.sqrt(1 + ratio);
      const multiplier = sqrtTerm - 1;
      
      // Конвертируем результат обратно в lamports
      const expectedTokenAmount = BigInt(Math.floor(yFloat * multiplier * Math.pow(10, tokenDecimals)));
      
      // Устанавливаем minTokenAmount как 90% от ожидаемого количества для учета проскальзывания
      const minTokenAmountLamports = expectedTokenAmount * BigInt(90) / BigInt(100);
      const maxSolCostLamports = amountInLamports;

      console.log('Calculation details:', {
        xFloat,
        yFloat,
        deltaXFloat,
        ratio,
        sqrtTerm,
        multiplier,
        expectedTokenAmount: Number(expectedTokenAmount) / Math.pow(10, tokenDecimals),
        minTokenAmount: Number(minTokenAmountLamports) / Math.pow(10, tokenDecimals),
        maxSolCost: Number(maxSolCostLamports) / LAMPORTS_PER_SOL,
        amountInSol,
        amountInLamports: amountInLamports.toString()
      });

      // Get token accounts
      const associatedUser = await getAssociatedTokenAddress(mint, payer.publicKey);
      const associatedBondingCurve = await getAssociatedTokenAddress(
        mint,
        bondingCurvePublicKey,
        true
      );

      // Create transaction
      const transaction = new Transaction();

      // Create user's ATA if it doesn't exist
      const accountInfo = await this.connection.getAccountInfo(associatedUser);
      if (!accountInfo) {
        console.log('Creating user ATA:', associatedUser.toString());
        transaction.add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            associatedUser,
            payer.publicKey,
            mint
          )
        );
      }

      // Prepare buy instruction data
      const buyDiscriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
      
      // Create buffers for the instruction data
      const minTokenAmountBuffer = Buffer.alloc(8);
      minTokenAmountBuffer.writeBigUInt64LE(minTokenAmountLamports);
      const maxSolCostBuffer = Buffer.alloc(8);
      maxSolCostBuffer.writeBigUInt64LE(maxSolCostLamports);

      const data = Buffer.concat([
        buyDiscriminator,
        minTokenAmountBuffer,
        maxSolCostBuffer,
      ]);

      console.log('Instruction data:', {
        minTokenAmountLamports: minTokenAmountLamports.toString(),
        maxSolCostLamports: maxSolCostLamports.toString(),
        minTokenAmountHex: minTokenAmountBuffer.toString('hex'),
        maxSolCostHex: maxSolCostBuffer.toString('hex')
      });

      // Create buy instruction
      const buyInstruction = new TransactionInstruction({
        programId: PUMP_FUN_PROGRAM_ID,
        keys: [
          { pubkey: GLOBAL_PDA, isSigner: false, isWritable: false },
          { pubkey: feeRecipient, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: bondingCurvePublicKey, isSigner: false, isWritable: true },
          { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
          { pubkey: associatedUser, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
          { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false }
        ],
        data,
      });

      transaction.add(buyInstruction);

      // Get latest blockhash and send transaction
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = payer.publicKey;

      console.log('Sending transaction...');
      const signature = await this.sendAndConfirmTransaction(
        transaction,
        [payer],
        { commitment: 'confirmed' }
      );

      // Проверяем результат транзакции
      const txInfo = await this.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });

      if (txInfo) {
        console.log('Transaction post-execution info:', {
          fee: txInfo.meta?.fee,
          preBalances: txInfo.meta?.preBalances,
          postBalances: txInfo.meta?.postBalances,
          logMessages: txInfo.meta?.logMessages
        });
      }

      console.log(`Token purchase successful! Transaction: ${signature}`);
      return signature;
    } catch (error: unknown) {
      console.error('Error buying tokens:', error);
      if (error && typeof error === 'object' && 'logs' in error) {
        console.error('Transaction logs:', (error as { logs: string[] }).logs);
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to buy tokens: ${errorMessage}`);
    }
  }

  /**
   * Создаёт токен пошагово и покупает начальное количество
   */
  async createTokenWithSteps(params: TokenCreationParams, initialBuyAmount?: number): Promise<TokenCreationWithBuyResult> {
    try {
      // 1. Проверяем обязательные параметры
      if (!params.name || params.name.trim().length === 0) {
        throw new Error('Token name is required');
      }
      if (!params.symbol || params.symbol.trim().length === 0) {
        throw new Error('Token symbol is required');
      }
      if (!params.description || params.description.trim().length === 0) {
        throw new Error('Token description is required');
      }
      if (!params.image) {
        throw new Error('Token image is required');
      }

      // 2. Устанавливаем кошелек для создания токена
      let wallet: Keypair | null;
      if (params.walletNumber !== undefined) {
        wallet = await this.setWalletForTokenCreation(params.walletNumber);
        if (!wallet) {
          throw new Error(`Failed to load wallet #${params.walletNumber}`);
        }
        this.walletService.setDevWallet(wallet);
      } else {
        wallet = this.walletService.getDevWallet();
        if (!wallet) {
          throw new Error('No wallet selected for token creation');
        }
      }

      // Проверяем баланс кошелька
      const balance = await this.connection.getBalance(wallet.publicKey);
      const solBalance = balance / LAMPORTS_PER_SOL;
      console.log(`Using wallet ${wallet.publicKey.toString()} with balance ${solBalance} SOL`);

      if (solBalance < this.MIN_SOL_BALANCE) {
        throw new Error(`Insufficient SOL balance in wallet ${wallet.publicKey.toString()}. Required minimum ${this.MIN_SOL_BALANCE} SOL, but got ${solBalance.toFixed(4)} SOL`);
      }

      // 3. Создаём токен
      console.log('Creating token with parameters:');
      console.log('Name:', params.name);
      console.log('Symbol:', params.symbol);
      console.log('Description:', params.description);
      console.log('Twitter:', params.twitter === 'no' ? 'Not set' : params.twitter);
      console.log('Telegram:', params.telegram === 'no' ? 'Not set' : params.telegram);
      console.log('Website:', params.website === 'no' ? 'Not set' : params.website);
      console.log('Creator wallet:', wallet.publicKey.toString());

      const result = await this.createToken(
        params.name,
        params.symbol,
        params.description,
        params.image,
        params.twitter === 'no' ? undefined : params.twitter,
        params.telegram === 'no' ? undefined : params.telegram,
        params.website === 'no' ? undefined : params.website
      );

      // 4. Если указана сумма для покупки, выполняем покупку
      let buySignature: string | undefined;
      if (initialBuyAmount && initialBuyAmount > 0) {
        console.log(`Buying tokens for ${initialBuyAmount} SOL...`);
        buySignature = await this.buyTokens(
          new PublicKey(result.mintAddress),
          initialBuyAmount,
          0, // minTokenAmount больше не используется, так как рассчитывается внутри buyTokens
          wallet
        );
      }

      return {
        ...result,
        buySignature,
        buyAmount: initialBuyAmount,
      };
    } catch (error) {
      console.error('Error in token creation process:', error);
      throw error;
    }
  }

  /**
   * Продаёт токены через bonding curve
   * @param mint Адрес токена
   * @param tokenAmount Количество токенов для продажи
   * @param payer Кошелёк, выполняющий продажу
   * @returns Подпись транзакции
   */
  async sellTokens(
    mint: PublicKey,
    tokenAmount: number,
    payer: Keypair
  ): Promise<string> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000; // 1 second
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const feeRecipient = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
        console.log(`Attempt ${attempt}/${MAX_RETRIES} to sell tokens...`);
        
        // Get bonding curve PDA and token accounts
        const [bondingCurvePubkey] = await PublicKey.findProgramAddress(
          [Buffer.from("bonding-curve"), mint.toBuffer()],
          PUMP_FUN_PROGRAM_ID
        );
        
        const associatedUser = await getAssociatedTokenAddress(mint, payer.publicKey);
        const associatedBondingCurve = await getAssociatedTokenAddress(
          mint,
          bondingCurvePubkey,
          true
        );

        // Verify bonding curve and token balance
        const bondingCurveInfo = await this.connection.getAccountInfo(bondingCurvePubkey);
        if (!bondingCurveInfo) {
          throw new Error(`Bonding curve not found for mint ${mint.toBase58()}`);
        }

        // Проверяем состояние bonding curve
        const bondingCurveData = bondingCurveInfo.data;
        const virtualTokenReserves = bondingCurveData.readBigUInt64LE(8);  // Skip discriminator
        const virtualSolReserves = bondingCurveData.readBigUInt64LE(16);   

        console.log('Bonding curve state:', {
          virtualTokenReserves: virtualTokenReserves.toString(),
          virtualSolReserves: virtualSolReserves.toString()
        });

        // Проверяем баланс токенов
        const userTokenAccountInfo = await this.connection.getTokenAccountBalance(associatedUser);
        if (!userTokenAccountInfo?.value?.uiAmount) {
          throw new Error(`No token balance found for ${associatedUser.toBase58()}`);
        }

        const tokenDecimals = userTokenAccountInfo.value.decimals;
        const tokenAmountLamports = BigInt(Math.floor(tokenAmount * Math.pow(10, tokenDecimals)));
        const userTokenBalance = BigInt(userTokenAccountInfo.value.amount);

        console.log('Token balance info:', {
          userBalance: userTokenAccountInfo.value.uiAmount,
          amountToSell: tokenAmount,
          tokenDecimals,
          tokenAmountLamports: tokenAmountLamports.toString(),
          userTokenBalanceLamports: userTokenBalance.toString()
        });

        if (userTokenBalance < tokenAmountLamports) {
          throw new Error(`Insufficient token balance. Required: ${tokenAmount}, Available: ${userTokenAccountInfo.value.uiAmount}`);
        }

        // Create and prepare transaction
        const transaction = new Transaction();
        const sellInstruction = new TransactionInstruction({
          programId: PUMP_FUN_PROGRAM_ID,
          keys: [
            { pubkey: GLOBAL_PDA, isSigner: false, isWritable: false },
            { pubkey: feeRecipient, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurvePubkey, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedUser, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false }
          ],
          data: Buffer.concat([
            Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]), // Правильный дискриминатор для sell
            (() => { 
              const buf = Buffer.alloc(8);
              buf.writeBigUInt64LE(tokenAmountLamports);
              return buf;
            })(),
            (() => { 
              const buf = Buffer.alloc(8);
              buf.writeBigUInt64LE(BigInt(0)); // minSolOutput = 0 для максимальной продажи
              return buf;
            })()
          ])
        });

        transaction.add(sellInstruction);

        // Get fresh blockhash for each attempt
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = payer.publicKey;

        // Simulate transaction first
        console.log('Simulating transaction...');
        const simulation = await this.connection.simulateTransaction(transaction, [payer]);
        
        if (simulation.value.err) {
          console.error('Simulation error details:', {
            error: simulation.value.err,
            logs: simulation.value.logs
          });
          throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
        }

        // Send and confirm transaction
        console.log('Sending transaction...');
        const signature = await this.sendAndConfirmTransaction(
          transaction,
          [payer],
          {
            commitment: 'confirmed',
            skipPreflight: false,
            maxRetries: 3,
            preflightCommitment: 'confirmed'
          }
        );

        // Additional confirmation check
        const confirmation = await this.connection.confirmTransaction({
          signature,
          blockhash,
          lastValidBlockHeight
        }, 'confirmed');

        if (confirmation.value.err) {
          throw new Error(`Transaction confirmation failed: ${confirmation.value.err}`);
        }

        // Проверяем результат транзакции
        const txInfo = await this.connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });

        if (txInfo) {
          console.log('Transaction post-execution info:', {
            fee: txInfo.meta?.fee,
            preBalances: txInfo.meta?.preBalances,
            postBalances: txInfo.meta?.postBalances,
            logMessages: txInfo.meta?.logMessages
          });
        }

        console.log(`Token sell successful! Transaction: ${signature}`);
        return signature;

      } catch (error) {
        console.error(`Error in attempt ${attempt}:`, error);
        
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        lastError = error instanceof Error ? error : new Error(errorMessage);

        // Проверяем специфические ошибки Pump.fun
        if (errorMessage.includes('Custom program error: 0x66')) {
          throw new Error('Продажа токенов временно заблокирована');
        }

        if (attempt < MAX_RETRIES) {
          const retryDelay = RETRY_DELAY * attempt;
          console.log(`Retrying in ${retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }
        
        throw new Error(`Failed to sell tokens after ${MAX_RETRIES} attempts: ${errorMessage}`);
      }
    }

    throw new Error('Failed to sell tokens: Unexpected error');
  }

  /**
   * Продает все токены со всех кошельков
   * @param mint Адрес токена
   * @returns Массив результатов продажи
   */
  async sellAllTokens(
    mint: PublicKey,
    progressCallback?: (text: string) => Promise<void>
  ): Promise<{ walletNumber: number; signature?: string; error?: string }[]> {
    const results: { walletNumber: number; signature?: string; error?: string }[] = [];
    const DELAY_BETWEEN_REQUESTS = 200; // 200 миллисекунд между запросами
    
    try {
      console.log('Starting sellAllTokens process...');
      
      // Сначала проверяем dev кошелек (wallet #0)
      console.log('Checking dev wallet (wallet #0)...');
      if (progressCallback) {
        await progressCallback('Проверка баланса dev кошелька...');
      }

      try {
        const devWallet = this.walletService.getDevWallet();
        if (devWallet) {
          console.log('Getting token account for dev wallet...');
          const associatedUser = await getAssociatedTokenAddress(mint, devWallet.publicKey);
          
          try {
            console.log('Checking token balance for dev wallet...');
            const tokenBalance = await this.connection.getTokenAccountBalance(associatedUser);
            if (tokenBalance && tokenBalance.value.uiAmount && tokenBalance.value.uiAmount > 0) {
              console.log(`Found ${tokenBalance.value.uiAmount} tokens in dev wallet`);
              if (progressCallback) {
                await progressCallback(`Продажа ${tokenBalance.value.uiAmount} токенов с dev кошелька...`);
              }

              const signature = await this.sellTokens(
                mint,
                tokenBalance.value.uiAmount,
                devWallet
              );
              
              console.log(`Successfully sold tokens from dev wallet, signature: ${signature}`);
              results.push({ walletNumber: 0, signature });
              
              // Добавляем задержку после продажи
              await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
            } else {
              console.log('No tokens found in dev wallet');
            }
          } catch (error) {
            console.log('Token account not found for dev wallet, skipping');
          }
        } else {
          console.log('Dev wallet not found, skipping');
        }
      } catch (error) {
        console.error('Error processing dev wallet:', error);
        results.push({ walletNumber: 0, error: error instanceof Error ? error.message : 'Unknown error' });
      }
      
      // Продаем с bundle кошельков (1-23)
      console.log('Processing bundle wallets (1-23)...');
      for (let i = 1; i <= 23; i++) {
        if (progressCallback) {
          await progressCallback(`Проверка баланса кошелька #${i}...`);
        }

        try {
          console.log(`Getting wallet #${i}...`);
          const wallet = await this.walletService.getWallet(i);
          if (!wallet) {
            console.log(`Wallet #${i} not found, skipping`);
            continue;
          }

          // Добавляем задержку перед запросом
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));

          console.log(`Getting token account for wallet #${i}...`);
          const associatedUser = await getAssociatedTokenAddress(mint, wallet.publicKey);
          
          try {
            console.log(`Checking token balance for wallet #${i}...`);
            const tokenBalance = await this.connection.getTokenAccountBalance(associatedUser);
            if (tokenBalance && tokenBalance.value.uiAmount && tokenBalance.value.uiAmount > 0) {
              console.log(`Found ${tokenBalance.value.uiAmount} tokens in wallet #${i}`);
              if (progressCallback) {
                await progressCallback(`Продажа ${tokenBalance.value.uiAmount} токенов с кошелька #${i}...`);
              }

              const signature = await this.sellTokens(
                mint,
                tokenBalance.value.uiAmount,
                wallet
              );
              
              console.log(`Successfully sold tokens from wallet #${i}, signature: ${signature}`);
              results.push({ walletNumber: i, signature });
              
              // Добавляем задержку после продажи
              await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
            } else {
              console.log(`No tokens found in wallet #${i}`);
            }
          } catch (error) {
            console.log(`Token account not found for wallet #${i}, skipping`);
            continue;
          }
        } catch (error) {
          console.error(`Error processing wallet #${i}:`, error);
          results.push({ walletNumber: i, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      }

      // Продаем с market making кошельков (26-100)
      console.log('Processing market making wallets (26-100)...');
      for (let i = 26; i <= 100; i++) {
        if (progressCallback) {
          await progressCallback(`Проверка баланса кошелька #${i}...`);
        }

        try {
          console.log(`Getting wallet #${i}...`);
          const wallet = await this.walletService.getWallet(i);
          if (!wallet) {
            console.log(`Wallet #${i} not found, skipping`);
            continue;
          }

          // Добавляем задержку перед запросом
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));

          console.log(`Getting token account for wallet #${i}...`);
          const associatedUser = await getAssociatedTokenAddress(mint, wallet.publicKey);
          
          try {
            console.log(`Checking token balance for wallet #${i}...`);
            const tokenBalance = await this.connection.getTokenAccountBalance(associatedUser);
            if (tokenBalance && tokenBalance.value.uiAmount && tokenBalance.value.uiAmount > 0) {
              console.log(`Found ${tokenBalance.value.uiAmount} tokens in wallet #${i}`);
              if (progressCallback) {
                await progressCallback(`Продажа ${tokenBalance.value.uiAmount} токенов с кошелька #${i}...`);
              }

              const signature = await this.sellTokens(
                mint,
                tokenBalance.value.uiAmount,
                wallet
              );
              
              console.log(`Successfully sold tokens from wallet #${i}, signature: ${signature}`);
              results.push({ walletNumber: i, signature });
              
              // Добавляем задержку после продажи
              await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
            } else {
              console.log(`No tokens found in wallet #${i}`);
            }
          } catch (error) {
            console.log(`Token account not found for wallet #${i}, skipping`);
            continue;
          }
        } catch (error) {
          console.error(`Error processing wallet #${i}:`, error);
          results.push({ walletNumber: i, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      }

      console.log('sellAllTokens process completed');
      return results;
    } catch (error) {
      console.error('Error in sellAllTokens:', error);
      throw error;
    }
  }

  async distributeTokensViaProxy(
    mint: PublicKey,
    fromWallet: Keypair,
    targetWallets: number[],
    proxyWallets: number[],
    progressCallback?: (text: string) => Promise<void>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Сначала распределяем токены по прокси-кошелькам
      const tokensPerProxy = Math.ceil(targetWallets.length / proxyWallets.length);
      
      // Получаем баланс токенов на исходном кошельке
      const fromTokenAccount = await getAssociatedTokenAddress(mint, fromWallet.publicKey);
      const balance = await this.connection.getTokenAccountBalance(fromTokenAccount);
      const totalTokens = balance.value.uiAmount || 0;
      
      // Вычисляем количество токенов для каждого прокси
      const tokensPerDistribution = totalTokens / proxyWallets.length;

      // 2. Отправляем токены на прокси-кошельки
      for (let i = 0; i < proxyWallets.length; i++) {
        if (progressCallback) {
          await progressCallback(`Отправка токенов на прокси-кошелек #${proxyWallets[i]}...`);
        }

        const proxyWallet = await this.walletService.getWallet(proxyWallets[i]);
        if (!proxyWallet) continue;

        await this.transferTokens(
          mint,
          fromWallet,
          proxyWallet.publicKey,
          tokensPerDistribution
        );

        // Добавляем задержку между транзакциями
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // 3. Распределяем токены с прокси-кошельков на целевые
      for (let i = 0; i < targetWallets.length; i++) {
        const proxyIndex = Math.floor(i / tokensPerProxy);
        const proxyWallet = await this.walletService.getWallet(proxyWallets[proxyIndex]);
        const targetWallet = await this.walletService.getWallet(targetWallets[i]);

        if (!proxyWallet || !targetWallet) continue;

        if (progressCallback) {
          await progressCallback(
            `Распределение токенов с прокси #${proxyWallets[proxyIndex]} на кошелек #${targetWallets[i]}...`
          );
        }

        await this.transferTokens(
          mint,
          proxyWallet,
          targetWallet.publicKey,
          tokensPerDistribution / tokensPerProxy
        );

        // Добавляем задержку между транзакциями
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      return { success: true };
    } catch (error) {
      console.error('Error in distributeTokensViaProxy:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  // Вспомогательная функция для трансфера токенов
  private async transferTokens(
    mint: PublicKey,
    fromWallet: Keypair,
    toPublicKey: PublicKey,
    amount: number
  ): Promise<string> {
    const fromTokenAccount = await getAssociatedTokenAddress(mint, fromWallet.publicKey);
    const toTokenAccount = await getAssociatedTokenAddress(mint, toPublicKey);

    // Проверяем существование целевого токен-аккаунта
    const toAccountInfo = await this.connection.getAccountInfo(toTokenAccount);
    const transaction = new Transaction();

    // Если целевой токен-аккаунт не существует, создаем его
    if (!toAccountInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          fromWallet.publicKey,
          toTokenAccount,
          toPublicKey,
          mint
        )
      );
    }

    // Добавляем инструкцию трансфера
    transaction.add(
      createTransferInstruction(
        fromTokenAccount,
        toTokenAccount,
        fromWallet.publicKey,
        Math.floor(amount * Math.pow(10, 6)) // Конвертируем в минимальные единицы (6 decimals)
      )
    );

    // Отправляем транзакцию
    const signature = await this.sendAndConfirmTransaction(
      transaction,
      [fromWallet],
      { commitment: 'confirmed' }
    );

    return signature;
  }

  /**
   * Распределяет токены для bundle кошельков через прокси
   * @param mint Адрес токена
   * @param progressCallback Callback для отображения прогресса
   */
  async distributeBundleViaProxy(
    mint: PublicKey,
    progressCallback?: (text: string) => Promise<void>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const devWallet = this.walletService.getDevWallet();
      if (!devWallet) {
        throw new Error('Dev wallet not found');
      }

      // Bundle кошельки (1-23)
      const bundleWallets = Array.from({length: 23}, (_, i) => i + 1);
      // Используем кошельки 24-25 как прокси
      const proxyWallets = [24, 25];

      if (progressCallback) {
        await progressCallback('Начинаем распределение bundle токенов через прокси...');
      }

      return await this.distributeTokensViaProxy(
        mint,
        devWallet,
        bundleWallets,
        proxyWallets,
        progressCallback
      );
    } catch (error) {
      console.error('Error in distributeBundleViaProxy:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Распределяет токены для market making кошельков через прокси
   * @param mint Адрес токена
   * @param progressCallback Callback для отображения прогресса
   */
  async distributeMarketMakingViaProxy(
    mint: PublicKey,
    progressCallback?: (text: string) => Promise<void>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const devWallet = this.walletService.getDevWallet();
      if (!devWallet) {
        throw new Error('Dev wallet not found');
      }

      // Проверяем баланс токенов на dev кошельке
      const devTokenAccount = await getAssociatedTokenAddress(mint, devWallet.publicKey);
      const devTokenBalance = await this.connection.getTokenAccountBalance(devTokenAccount);
      if (!devTokenBalance?.value?.uiAmount || devTokenBalance.value.uiAmount === 0) {
        throw new Error('No tokens found in dev wallet');
      }

      // Market making кошельки (26-100)
      const mmWallets = Array.from({length: 75}, (_, i) => i + 26);
      // Используем кошельки 101-105 как прокси для лучшего распределения
      const proxyWallets = [101, 102, 103, 104, 105];

      if (progressCallback) {
        await progressCallback(`Начинаем распределение ${devTokenBalance.value.uiAmount} токенов через ${proxyWallets.length} прокси-кошельков...`);
      }

      // Распределяем токены через прокси
      const result = await this.distributeTokensViaProxy(
        mint,
        devWallet,
        mmWallets,
        proxyWallets,
        progressCallback
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to distribute tokens via proxy');
      }

      return { success: true };
    } catch (error) {
      console.error('Error in distributeMarketMakingViaProxy:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Распределяет SOL с прокси-кошелька на целевые кошельки с вариацией сумм
   * @param amount Общая сумма SOL для распределения
   * @param proxyWalletNumber Номер прокси-кошелька
   * @param targetWalletNumbers Массив номеров целевых кошельков
   * @param progressCallback Callback для отображения прогресса
   */
  async distributeSolViaProxy(
    amount: number,
    proxyWalletNumber: number,
    targetWalletNumbers: number[],
    progressCallback?: (text: string) => Promise<void>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const proxyWallet = await this.walletService.getWallet(proxyWalletNumber);
      if (!proxyWallet) {
        throw new Error(`Proxy wallet #${proxyWalletNumber} not found`);
      }

      // Проверяем баланс прокси кошелька
      const proxyBalance = await this.getBalance(proxyWallet.publicKey);
      const proxyBalanceInSol = proxyBalance / LAMPORTS_PER_SOL;
      
      // Учитываем комиссии за транзакции (0.000005 SOL * количество транзакций)
      const totalFees = (0.000005 * targetWalletNumbers.length);
      const requiredBalance = amount + totalFees;
      
      if (proxyBalanceInSol < requiredBalance) {
        throw new Error(
          `Insufficient balance in proxy wallet #${proxyWalletNumber}. ` +
          `Required: ${requiredBalance.toFixed(6)} SOL (${amount.toFixed(6)} + ${totalFees.toFixed(6)} fees), ` +
          `Available: ${proxyBalanceInSol.toFixed(6)} SOL`
        );
      }

      // Базовая сумма на один кошелек (в лампортах для точности)
      const baseAmountLamports = Math.floor((amount * LAMPORTS_PER_SOL) / targetWalletNumbers.length);
      
      // Генерируем случайные вариации и считаем общую сумму
      const variations = targetWalletNumbers.map(() => 0.8 + Math.random() * 0.4); // от -20% до +20%
      const totalVariation = variations.reduce((sum, v) => sum + v, 0);
      const correctionFactor = targetWalletNumbers.length / totalVariation;
      
      // Корректируем вариации, чтобы сумма точно равнялась amount
      const finalAmounts = variations.map(v => {
        const correctedVariation = v * correctionFactor;
        return Math.floor(baseAmountLamports * correctedVariation);
      });

      // Распределяем остаток от округления на последний кошелек
      const totalDistributed = finalAmounts.reduce((sum, v) => sum + v, 0);
      const remainder = (amount * LAMPORTS_PER_SOL) - totalDistributed;
      if (remainder > 0) {
        finalAmounts[finalAmounts.length - 1] += remainder;
      }

      // Распределяем SOL на каждый кошелек
      for (let i = 0; i < targetWalletNumbers.length; i++) {
        const targetWalletNumber = targetWalletNumbers[i];
        const lamports = finalAmounts[i];
        const solAmount = lamports / LAMPORTS_PER_SOL;

        if (progressCallback) {
          await progressCallback(`Отправка ${solAmount.toFixed(9)} SOL на кошелек #${targetWalletNumber}...`);
        }

        const targetWallet = await this.walletService.getWallet(targetWalletNumber);
        if (!targetWallet) {
          console.log(`Wallet #${targetWalletNumber} not found, skipping`);
          continue;
        }

        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: proxyWallet.publicKey,
            toPubkey: targetWallet.publicKey,
            lamports: lamports,
          })
        );

        await this.sendAndConfirmTransaction(
          transaction,
          [proxyWallet],
          { commitment: 'confirmed' }
        );

        // Увеличенная базовая задержка между транзакциями
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 секунды между каждой транзакцией

        // Дополнительная длительная задержка после каждых 5 кошельков
        if ((i + 1) % 5 === 0) {
          if (progressCallback) {
            await progressCallback(`Делаем паузу для стабилизации RPC...`);
          }
          await new Promise(resolve => setTimeout(resolve, 5000)); // 5 секунд после каждых 5 кошельков
        }

        // Ещё более длительная задержка после каждых 10 кошельков
        if ((i + 1) % 10 === 0) {
          if (progressCallback) {
            await progressCallback(`Длительная пауза для избежания ошибок RPC...`);
          }
          await new Promise(resolve => setTimeout(resolve, 10000)); // 10 секунд после каждых 10 кошельков
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Error in distributeSolViaProxy:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Распределяет SOL для bundle кошельков (1-23) через прокси (24)
   * @param amount Сумма SOL для распределения
   * @param progressCallback Callback для отображения прогресса
   */
  async distributeBundleSol(
    amount: number,
    progressCallback?: (text: string) => Promise<void>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const PROXY_WALLET = 24;
      const bundleWallets = Array.from({length: 23}, (_, i) => i + 1);

      if (progressCallback) {
        await progressCallback(`Начинаем распределение ${amount} SOL через прокси-кошелек #${PROXY_WALLET}...`);
      }

      return await this.distributeSolViaProxy(
        amount,
        PROXY_WALLET,
        bundleWallets,
        progressCallback
      );
    } catch (error) {
      console.error('Error in distributeBundleSol:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Распределяет SOL для market making кошельков (26-100) через прокси (25)
   * @param amount Сумма SOL для распределения
   * @param progressCallback Callback для отображения прогресса
   */
  async distributeMarketMakingSol(
    amount: number,
    progressCallback?: (text: string) => Promise<void>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const PROXY_WALLET = 25;
      const mmWallets = Array.from({length: 75}, (_, i) => i + 26);

      if (progressCallback) {
        await progressCallback(`Начинаем распределение ${amount} SOL через прокси-кошелек #${PROXY_WALLET}...`);
      }

      return await this.distributeSolViaProxy(
        amount,
        PROXY_WALLET,
        mmWallets,
        progressCallback
      );
    } catch (error) {
      console.error('Error in distributeMarketMakingSol:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}