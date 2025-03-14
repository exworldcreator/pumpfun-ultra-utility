import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  AddressLookupTableProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { WalletData } from './WalletService.js';

export class LookupTableService {
  private connection: Connection;
  
  constructor(rpcUrl: string = 'https://api.mainnet-beta.solana.com') {
    this.connection = new Connection(rpcUrl);
  }

  /**
   * Create a new Address Lookup Table
   * @param payerWallet The wallet that will pay for the LUT creation
   * @param addresses The addresses to add to the LUT
   * @param label Optional label for the LUT (for logging purposes)
   * @returns The address of the created LUT
   */
  async createLookupTable(
    payerWallet: Keypair,
    addresses: PublicKey[],
    label: string = ''
  ): Promise<string> {
    try {
      // Check payer wallet balance
      const balance = await this.connection.getBalance(payerWallet.publicKey);
      const balanceInSOL = balance / LAMPORTS_PER_SOL;
      
      if (balanceInSOL < 0.03) {
        throw new Error(`Dev wallet has insufficient SOL (${balanceInSOL.toFixed(4)} SOL) for creating Lookup Tables. Please fund with at least 0.03 SOL.`);
      }

      console.log(`Creating ${label ? label + ' ' : ''}lookup table with ${addresses.length} addresses...`);

      // Get recent slot for LUT creation with retries
      let slot: number;
      let retries = 3;
      let lastError: Error | null = null;

      while (retries > 0) {
        try {
          // Get the most recent finalized slot
          slot = await this.connection.getSlot('finalized');
          console.log('Using slot for LUT creation:', slot);
          break;
        } catch (error) {
          lastError = error as Error;
          retries--;
          if (retries > 0) {
            console.log(`Failed to get slot, retrying... (${retries} attempts left)`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }

      if (retries === 0 && lastError) {
        throw new Error(`Failed to get recent slot after multiple attempts: ${lastError.message}`);
      }

      // Create instruction to create a new LUT
      const [createInstruction, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
        authority: payerWallet.publicKey,
        payer: payerWallet.publicKey,
        recentSlot: slot!
      });

      // Create transaction to create the LUT
      const createTransaction = new Transaction().add(createInstruction);
      
      // Получаем актуальный блокхеш перед отправкой транзакции
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      createTransaction.recentBlockhash = blockhash;
      createTransaction.lastValidBlockHeight = lastValidBlockHeight;
      
      // Send and confirm the transaction
      const createSignature = await sendAndConfirmTransaction(
        this.connection,
        createTransaction,
        [payerWallet],
        { 
          commitment: 'confirmed' as const,
          skipPreflight: false,
          maxRetries: 5
        }
      );
      
      console.log(`Created lookup table: ${lookupTableAddress.toBase58()}`);
      console.log(`Transaction signature: ${createSignature}`);
      
      // Wait longer to make sure the LUT is ready
      console.log('Waiting for lookup table to be confirmed...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Add addresses to the LUT in batches (max 30 per transaction)
      const batchSize = 30;
      for (let i = 0; i < addresses.length; i += batchSize) {
        const batch = addresses.slice(i, i + batchSize);
        
        // Create instruction to extend the LUT with addresses
        const extendInstruction = AddressLookupTableProgram.extendLookupTable({
          payer: payerWallet.publicKey,
          authority: payerWallet.publicKey,
          lookupTable: lookupTableAddress,
          addresses: batch
        });

        // Create and send transaction to extend the LUT
        const extendTransaction = new Transaction().add(extendInstruction);
        
        try {
          // Получаем актуальный блокхеш перед отправкой транзакции
          const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
          extendTransaction.recentBlockhash = blockhash;
          extendTransaction.lastValidBlockHeight = lastValidBlockHeight;
          
          const extendSignature = await sendAndConfirmTransaction(
            this.connection,
            extendTransaction,
            [payerWallet],
            { 
              commitment: 'confirmed' as const,
              skipPreflight: false,
              maxRetries: 5
            }
          );
          
          console.log(`Extended lookup table with ${batch.length} addresses`);
          console.log(`Transaction signature: ${extendSignature}`);
          
          // Wait between batches to avoid rate limits and ensure confirmation
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          console.error(`Failed to extend LUT with batch ${i / batchSize + 1}:`, error);
          throw error;
        }
      }

      // Wait for final confirmation before returning
      console.log('Waiting for final lookup table confirmation...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Verify the lookup table exists
      await this.getLookupTable(lookupTableAddress.toBase58());
      
      return lookupTableAddress.toBase58();
    } catch (error) {
      console.error('Error creating lookup table:', error);
      throw error;
    }
  }

  /**
   * Create a transaction using a Lookup Table
   * @param payerWallet The wallet that will pay for the transaction
   * @param instructions The instructions to include in the transaction
   * @param lookupTableAddress The address of the LUT to use
   * @returns The transaction signature
   */
  async createTransactionWithLookupTable(
    payerWallet: WalletData,
    instructions: TransactionInstruction[],
    lookupTableAddress: string
  ): Promise<string> {
    try {
      const payerKeypair = Keypair.fromSecretKey(
        Buffer.from(payerWallet.privateKey, 'base64')
      );
      
      // Get the lookup table account
      const lookupTableAccount = await this.getLookupTable(lookupTableAddress);
      
      // Get latest blockhash
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      
      // Create a versioned transaction with the lookup table
      const messageV0 = new TransactionMessage({
        payerKey: payerKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions
      }).compileToV0Message([lookupTableAccount]);
      
      const transaction = new VersionedTransaction(messageV0);
      
      // Sign the transaction
      transaction.sign([payerKeypair]);
      
      // Send the transaction
      const signature = await this.connection.sendTransaction(transaction);
      
      // Confirm the transaction
      await this.connection.confirmTransaction({
        blockhash,
        lastValidBlockHeight,
        signature
      });
      
      return signature;
    } catch (error) {
      console.error('Error creating transaction with lookup table:', error);
      throw error;
    }
  }

  /**
   * Get a Lookup Table account with retries
   * @param lookupTableAddress The address of the LUT
   * @returns The LUT account
   */
  async getLookupTable(lookupTableAddress: string): Promise<AddressLookupTableAccount> {
    let retries = 5;
    let lastError: Error | null = null;
    
    while (retries > 0) {
      try {
        const lookupTableAccountInfo = await this.connection.getAddressLookupTable(
          new PublicKey(lookupTableAddress)
        );
        
        if (!lookupTableAccountInfo || !lookupTableAccountInfo.value) {
          throw new Error(`Lookup table not found: ${lookupTableAddress}`);
        }
        
        return lookupTableAccountInfo.value;
      } catch (error) {
        lastError = error as Error;
        retries--;
        if (retries > 0) {
          console.log(`Failed to get lookup table, retrying in 2 seconds... (${retries} attempts left)`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    throw lastError || new Error(`Failed to get lookup table after multiple attempts: ${lookupTableAddress}`);
  }

  /**
   * Get all addresses in a Lookup Table
   * @param lookupTableAddress The address of the LUT
   * @returns Array of addresses in the LUT
   */
  async getLookupTableAddresses(lookupTableAddress: string): Promise<string[]> {
    const lookupTable = await this.getLookupTable(lookupTableAddress);
    return lookupTable.state.addresses.map(address => address.toBase58());
  }
} 