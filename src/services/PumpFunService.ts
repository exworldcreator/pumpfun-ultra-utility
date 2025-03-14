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
  private readonly connection: Connection;
  private walletService: WalletService;
  public readonly MIN_SOL_BALANCE = 0.015;
  private readonly metaplex: Metaplex;

  constructor(walletService: WalletService, rpcUrl: string = 'https://api.mainnet-beta.solana.com') {
    this.walletService = walletService;
    this.connection = new Connection(rpcUrl);
    this.metaplex = new Metaplex(this.connection);
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

      const signature = await sendAndConfirmTransaction(
        this.connection,
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
      // Use the known working fee recipient
      const feeRecipient = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
      console.log('Using fee recipient:', feeRecipient.toBase58());

      // Get bonding curve PDA
      const [bondingCurvePublicKey] = await PublicKey.findProgramAddress(
        [Buffer.from("bonding-curve"), mint.toBuffer()],
        PUMP_FUN_PROGRAM_ID
      );

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

      // Prepare buy instruction data exactly as in the successful transaction
      const buyDiscriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
      const tokenDecimals = 6;
      const minTokenAmountLamports = BigInt(Math.floor(minTokenAmount * Math.pow(10, tokenDecimals)));
      const maxSolCostLamports = BigInt(Math.floor(amountInSol * LAMPORTS_PER_SOL));

      // Create buffers for the instruction data
      const minTokenAmountBuffer = Buffer.alloc(8);
      minTokenAmountBuffer.writeBigUInt64LE(minTokenAmountLamports);
      const maxSolCostBuffer = Buffer.alloc(8);
      maxSolCostBuffer.writeBigUInt64LE(maxSolCostLamports);

      // Combine the data in the correct order
      const data = Buffer.concat([
        buyDiscriminator,
        minTokenAmountBuffer,
        maxSolCostBuffer,
      ]);

      console.log('Instruction data:', {
        amount: minTokenAmountLamports.toString(),
        maxSolCost: maxSolCostLamports.toString()
      });

      // Create buy instruction with exact account structure from the successful transaction
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
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [payer],
        { 
          commitment: 'confirmed',
          skipPreflight: false
        }
      );

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
          50, // Минимальное количество токенов, которое хотим получить
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
}