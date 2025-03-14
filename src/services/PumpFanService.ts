import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY, TransactionInstruction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import axios from 'axios';

export class PumpFanService {
  private connection: Connection;
  private readonly PUMPFAN_API = 'https://api.pumpfan.com/v1';
  private readonly PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  private readonly GLOBAL_PDA = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  private readonly EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  private readonly FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');

  constructor(rpcUrl: string = 'https://api.mainnet-beta.solana.com') {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  public async createToken(params: {
    name: string;
    symbol: string;
    description: string;
    image: string;
    twitter?: string;
    telegram?: string;
    website?: string;
    devWallet: Keypair;
  }): Promise<string> {
    try {
      // Get token creation instructions from PumpFan API
      const response = await axios.post(`${this.PUMPFAN_API}/create-token`, {
        name: params.name,
        symbol: params.symbol,
        description: params.description,
        image: params.image,
        twitter: params.twitter,
        telegram: params.telegram,
        website: params.website
      });

      const { tokenAddress, createTokenIx } = response.data;

      // Create and send transaction
      const transaction = new Transaction().add(createTokenIx);
      
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [params.devWallet],
        {
          commitment: 'confirmed',
          preflightCommitment: 'confirmed',
        }
      );

      console.log(`Token created with signature: ${signature}`);
      return tokenAddress;

    } catch (error) {
      console.error('Error creating token on PumpFan:', error);
      throw error;
    }
  }

  public async buyToken(params: {
    tokenAddress: string;
    buyerWallet: Keypair;
    amountInSol: number;
  }): Promise<string> {
    try {
      const mint = new PublicKey(params.tokenAddress);
      const buyerWallet = params.buyerWallet;
      const amountInLamports = Math.floor(params.amountInSol * LAMPORTS_PER_SOL);

      // Get bonding curve PDA
      const [bondingCurvePublicKey] = await PublicKey.findProgramAddress(
        [Buffer.from("bonding-curve"), mint.toBuffer()],
        this.PUMP_FUN_PROGRAM_ID
      );

      // Get bonding curve data to calculate price
      const bondingCurveInfo = await this.connection.getAccountInfo(bondingCurvePublicKey);
      if (!bondingCurveInfo) throw new Error('Bonding curve not found');

      // Десериализуем данные bonding curve
      const bondingCurveData = bondingCurveInfo.data;
      const virtualTokenReserves = bondingCurveData.readBigUInt64LE(8);  // Skip discriminator
      const virtualSolReserves = bondingCurveData.readBigUInt64LE(16);   
      const price = Number(virtualSolReserves) / Number(virtualTokenReserves);

      // Calculate expected token amount based on current price
      const tokenDecimals = 6;
      const expectedTokenAmount = Math.floor((params.amountInSol / price) * Math.pow(10, tokenDecimals));
      
      // Set minTokenAmount to 90% of expected amount to account for slippage
      const minTokenAmount = BigInt(Math.floor(expectedTokenAmount * 0.9));
      const maxSolCost = BigInt(amountInLamports);

      console.log('Buy parameters:', {
        virtualTokenReserves: virtualTokenReserves.toString(),
        virtualSolReserves: virtualSolReserves.toString(),
        currentPrice: price,
        amountInSol: params.amountInSol,
        expectedTokens: expectedTokenAmount / Math.pow(10, tokenDecimals),
        minTokens: Number(minTokenAmount) / Math.pow(10, tokenDecimals),
        maxSolCost: maxSolCost.toString()
      });

      // Get token accounts
      const associatedUser = await getAssociatedTokenAddress(mint, buyerWallet.publicKey);
      const associatedBondingCurve = await getAssociatedTokenAddress(
        mint,
        bondingCurvePublicKey,
        true
      );

      // Create transaction
      const transaction = new Transaction();

      // Check if we need to create ATA and if we have enough SOL for rent
      const accountInfo = await this.connection.getAccountInfo(associatedUser);
      const rentExemptBalance = await this.connection.getMinimumBalanceForRentExemption(165); // Token account size
      
      if (!accountInfo) {
        const userBalance = await this.connection.getBalance(buyerWallet.publicKey);
        if (userBalance < (rentExemptBalance + amountInLamports)) {
          throw new Error(`Insufficient balance for rent. Need ${rentExemptBalance/LAMPORTS_PER_SOL} SOL for rent`);
        }

        console.log('Creating user ATA:', associatedUser.toString());
        transaction.add(
          createAssociatedTokenAccountInstruction(
            buyerWallet.publicKey,
            associatedUser,
            buyerWallet.publicKey,
            mint
          )
        );
      }

      // Prepare buy instruction data
      const buyDiscriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
      
      const minTokenAmountBuffer = Buffer.alloc(8);
      minTokenAmountBuffer.writeBigUInt64LE(minTokenAmount);
      const maxSolCostBuffer = Buffer.alloc(8);
      maxSolCostBuffer.writeBigUInt64LE(maxSolCost);

      const instructionData = Buffer.concat([
        buyDiscriminator,
        minTokenAmountBuffer,
        maxSolCostBuffer,
      ]);

      // Create buy instruction
      const buyInstruction = new TransactionInstruction({
        programId: this.PUMP_FUN_PROGRAM_ID,
        keys: [
          { pubkey: this.GLOBAL_PDA, isSigner: false, isWritable: false },
          { pubkey: this.FEE_RECIPIENT, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: bondingCurvePublicKey, isSigner: false, isWritable: true },
          { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
          { pubkey: associatedUser, isSigner: false, isWritable: true },
          { pubkey: buyerWallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: this.EVENT_AUTHORITY, isSigner: false, isWritable: false },
          { pubkey: this.PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false }
        ],
        data: instructionData,
      });

      transaction.add(buyInstruction);

      // Get latest blockhash and send transaction
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = buyerWallet.publicKey;

      console.log(`Buying ${params.amountInSol} SOL worth of tokens...`);
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [buyerWallet],
        { 
          commitment: 'confirmed',
          skipPreflight: false
        }
      );

      console.log(`Buy transaction successful: ${signature}`);
      return signature;

    } catch (error) {
      console.error('Error buying token:', error);
      throw error;
    }
  }

  public async getTokenUrl(tokenAddress: string): Promise<string> {
    return `https://pumpfan.com/token/${tokenAddress}`;
  }

  public async getPoolSize(tokenAddress: string): Promise<number> {
    try {
      const response = await axios.get(`${this.PUMPFAN_API}/token/${tokenAddress}`);
      return response.data.poolSize;
    } catch (error) {
      console.error('Error getting pool size:', error);
      throw error;
    }
  }

  public async waitForConfirmation(signature: string): Promise<void> {
    try {
      await this.connection.confirmTransaction(signature, 'confirmed');
    } catch (error) {
      console.error('Error confirming transaction:', error);
      throw error;
    }
  }
} 