import { 
    Connection, 
    PublicKey, 
    SystemProgram, 
    TransactionInstruction, 
    Keypair, 
    VersionedTransaction, 
    TransactionMessage,
    SYSVAR_RENT_PUBKEY,
    LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { 
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    createInitializeMint2Instruction,
    createMintToInstruction,
    createSetAuthorityInstruction,
    AuthorityType
} from '@solana/spl-token';
import { WalletService } from './WalletService';
import { TransactionService } from './TransactionService';
import { PumpFanService } from './PumpFanService';
import * as readline from 'readline';
import { promisify } from 'util';
import axios from 'axios';

interface TokenCreationParams {
    name: string;
    symbol: string;
    description: string;
    picture: string;
    twitter: string | null;
    telegram: string | null;
    website: string | null;
    devBuyAmount: number;
    bundleRetentionPercent: number;
}

export class TokenCreationService {
    private connection: Connection;
    private PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    private MINT_AUTHORITY = new PublicKey("AyY9zG2HAdy65CUXeU5vNE3cmTrz9VTNVLa1qoDcpump");
    private devWallet: Keypair | null = null;
    private walletService: WalletService;
    private transactionService: TransactionService;
    private pumpFanService: PumpFanService;
    private rl: readline.Interface;

    constructor(
        walletService: WalletService, 
        transactionService: TransactionService,
        rpcUrl: string = 'https://api.mainnet-beta.solana.com'
    ) {
        this.connection = new Connection(rpcUrl, 'confirmed');
        this.walletService = walletService;
        this.transactionService = transactionService;
        this.pumpFanService = new PumpFanService(rpcUrl);
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }

    setDevWallet(wallet: Keypair) {
        this.devWallet = wallet;
    }

    async createToken(
        name: string,
        symbol: string,
        mintKeypair: Keypair
    ): Promise<string> {
        if (!this.devWallet) {
            throw new Error('Dev wallet not set. Please call setDevWallet first.');
        }

        try {
            // Find PDA for bonding curve
            const [bondingCurvePublicKey] = await PublicKey.findProgramAddress(
                [Buffer.from("bonding-curve"), mintKeypair.publicKey.toBuffer()],
                this.PUMP_FUN_PROGRAM_ID
            );

            // Get associated token account for bonding curve
            const associatedBondingCurve = await getAssociatedTokenAddress(
                mintKeypair.publicKey,
                bondingCurvePublicKey,
                true
            );

            // Calculate space for mint account
            const mintSpace = 82;
            const mintRent = await this.connection.getMinimumBalanceForRentExemption(mintSpace);

            // Create mint account using dev wallet as payer
            const createMintAccountInstruction = SystemProgram.createAccount({
                fromPubkey: this.devWallet.publicKey,
                newAccountPubkey: mintKeypair.publicKey,
                space: mintSpace,
                lamports: mintRent,
                programId: TOKEN_PROGRAM_ID
            });

            // Initialize mint
            const initializeMintInstruction = createInitializeMint2Instruction(
                mintKeypair.publicKey,
                6, // decimals
                this.MINT_AUTHORITY,
                null
            );

            // Calculate space for bonding curve account
            const bondingCurveSpace = 200; // Adjust this value based on actual requirements
            const bondingCurveRent = await this.connection.getMinimumBalanceForRentExemption(bondingCurveSpace);

            // Create bonding curve account using dev wallet as payer
            const createBondingCurveInstruction = SystemProgram.createAccount({
                fromPubkey: this.devWallet.publicKey,
                newAccountPubkey: bondingCurvePublicKey,
                space: bondingCurveSpace,
                lamports: bondingCurveRent,
                programId: this.PUMP_FUN_PROGRAM_ID
            });

            // Create token instruction
            const createTokenInstruction = new TransactionInstruction({
                programId: this.PUMP_FUN_PROGRAM_ID,
                keys: [
                    { pubkey: this.devWallet.publicKey, isSigner: true, isWritable: true }, // Changed to dev wallet as payer
                    { pubkey: this.MINT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: bondingCurvePublicKey, isSigner: false, isWritable: true },
                    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
                    { pubkey: new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"), isSigner: false, isWritable: false },
                    { pubkey: mintKeypair.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
                    { pubkey: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"), isSigner: false, isWritable: false },
                    { pubkey: this.PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                data: Buffer.concat([
                    Buffer.from([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77]),
                    Buffer.from(name, 'utf8'),
                    Buffer.from([0x00]),
                    Buffer.from(symbol, 'utf8'),
                    Buffer.from([0x00])
                ])
            });

            // Mint tokens to bonding curve
            const mintToInstruction = createMintToInstruction(
                mintKeypair.publicKey,
                associatedBondingCurve,
                this.MINT_AUTHORITY,
                1_000_000_000 // Amount to mint
            );

            // Disable minting
            const disableMintingInstruction = createSetAuthorityInstruction(
                mintKeypair.publicKey,
                this.MINT_AUTHORITY,
                AuthorityType.MintTokens,
                null
            );

            // Get latest blockhash
            const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

            // Create transaction with all instructions
            const message = new TransactionMessage({
                payerKey: this.devWallet.publicKey,
                recentBlockhash: blockhash,
                instructions: [
                    createMintAccountInstruction,
                    initializeMintInstruction,
                    createBondingCurveInstruction,
                    createTokenInstruction,
                    mintToInstruction,
                    disableMintingInstruction
                ]
            }).compileToV0Message();

            const transaction = new VersionedTransaction(message);
            transaction.sign([this.devWallet, mintKeypair]); // Sign with both dev wallet and mint keypair

            // Simulate transaction first
            const simulation = await this.connection.simulateTransaction(transaction);
            if (simulation.value.err) {
                throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
            }

            // Send transaction
            const signature = await this.connection.sendTransaction(transaction);
            await this.connection.confirmTransaction(signature);

            return signature;
        } catch (error) {
            console.error('Error creating token:', error);
            throw new Error(`Failed to create token: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async question(query: string): Promise<string> {
        return new Promise((resolve) => this.rl.question(query, resolve));
    }

    private validateSolAmount(amount: string): number {
        const num = parseFloat(amount);
        if (isNaN(num) || num <= 0) {
            throw new Error('Invalid SOL amount. Please enter a positive number.');
        }
        return num;
    }

    private validatePercentage(percent: string): number {
        const num = parseFloat(percent);
        if (isNaN(num) || num < 0 || num > 100) {
            throw new Error('Invalid percentage. Please enter a number between 0 and 100.');
        }
        return num;
    }

    public async createAndBuyToken(): Promise<string> {
        try {
            // Select wallet set 13a
            console.log('Using wallet set 13a...');
            await this.walletService.selectWalletSet('13a');

            // Gather token parameters
            const params = await this.gatherTokenParameters();

            // Show summary and confirm
            await this.showAndConfirmParameters(params);

            // Get dev wallet
            const devWallet = this.walletService.getWalletByIndex(0);
            if (!devWallet) {
                throw new Error('Dev wallet not found');
            }

            // Create token on PumpFan
            console.log('\nCreating token on PumpFan...');
            const tokenAddress = await this.pumpFanService.createToken({
                name: params.name,
                symbol: params.symbol,
                description: params.description,
                image: params.picture,
                twitter: params.twitter || undefined,
                telegram: params.telegram || undefined,
                website: params.website || undefined,
                devWallet: devWallet
            });

            console.log(`Token created successfully: ${tokenAddress}`);

            // Execute buys
            await this.executeBundleBuys(tokenAddress, params);

            // Get PumpFan token URL
            const tokenUrl = await this.pumpFanService.getTokenUrl(tokenAddress);
            console.log(`\nToken successfully created and bought! 🎉`);
            console.log(`View your token here: ${tokenUrl}`);

            return tokenUrl;

        } catch (error) {
            console.error('Error in token creation process:', error);
            throw error;
        } finally {
            this.rl.close();
        }
    }

    private async gatherTokenParameters(): Promise<TokenCreationParams> {
        const name = await this.question('Enter Token Name: ');
        const symbol = await this.question('Enter Token Symbol: ');
        const description = await this.question('Enter Token Description: ');
        const picture = await this.question('Enter Token Picture URL: ');
        
        let twitterInput = await this.question('Enter Twitter (or "no" to skip): ');
        const twitter: string | null = twitterInput.toLowerCase() === 'no' ? null : twitterInput;
        
        let telegramInput = await this.question('Enter Telegram (or "no" to skip): ');
        const telegram: string | null = telegramInput.toLowerCase() === 'no' ? null : telegramInput;
        
        let websiteInput = await this.question('Enter Website (or "no" to skip): ');
        const website: string | null = websiteInput.toLowerCase() === 'no' ? null : websiteInput;

        const devBuyAmountStr = await this.question('Enter amount of SOL to buy with dev wallet: ');
        const devBuyAmount = this.validateSolAmount(devBuyAmountStr);

        const retentionPercentStr = await this.question('Enter percentage of SOL to retain on each bundle wallet: ');
        const bundleRetentionPercent = this.validatePercentage(retentionPercentStr);

        return {
            name,
            symbol,
            description,
            picture,
            twitter,
            telegram,
            website,
            devBuyAmount,
            bundleRetentionPercent
        };
    }

    private async showAndConfirmParameters(params: TokenCreationParams): Promise<void> {
        console.log('\nToken Creation Summary:');
        console.log('----------------------');
        console.log(`Name: ${params.name}`);
        console.log(`Symbol: ${params.symbol}`);
        console.log(`Description: ${params.description}`);
        console.log(`Picture: ${params.picture}`);
        if (params.twitter) console.log(`Twitter: ${params.twitter}`);
        if (params.telegram) console.log(`Telegram: ${params.telegram}`);
        if (params.website) console.log(`Website: ${params.website}`);
        console.log(`Dev Wallet Buy Amount: ${params.devBuyAmount} SOL`);
        console.log(`Bundle Retention: ${params.bundleRetentionPercent}%`);
        console.log('----------------------');

        const confirmation = await this.question('\nIs everything correct? (yes/no): ');
        if (confirmation.toLowerCase() !== 'yes') {
            throw new Error('Operation cancelled by user');
        }
    }

    private async executeBundleBuys(tokenAddress: string, params: TokenCreationParams): Promise<void> {
        console.log('\nExecuting buys...');

        // First, execute dev wallet buy
        await this.executeDevWalletBuy(tokenAddress, params.devBuyAmount);

        // Then execute bundle buys
        await this.executeBundleWalletBuys(tokenAddress, params.bundleRetentionPercent);
    }

    private async executeDevWalletBuy(tokenAddress: string, amount: number): Promise<void> {
        console.log(`\nBuying ${amount} SOL with dev wallet...`);
        
        const devWallet = this.walletService.getWalletByIndex(0);
        if (!devWallet) {
            throw new Error('Dev wallet not found');
        }

        const signature = await this.pumpFanService.buyToken({
            tokenAddress,
            buyerWallet: devWallet,
            amountInSol: amount
        });

        await this.pumpFanService.waitForConfirmation(signature);
        console.log(`Dev wallet buy completed: ${signature}`);
    }

    private async executeBundleWalletBuys(tokenAddress: string, retentionPercent: number): Promise<void> {
        console.log('\nExecuting bundle wallet buys...');
        const MAX_POOL_SIZE = 85; // Maximum pool size in SOL
        let totalBought = 0;
        let failedAttempts = 0;
        const MAX_RETRIES = 3;

        // Process first 23 wallets
        for (let i = 1; i <= 23; i++) {
            const wallet = this.walletService.getWalletByIndex(i);
            if (!wallet) continue;

            const balance = await this.transactionService.getWalletBalance(i);
            if (balance <= 0) {
                console.log(`Skipping wallet #${i} - no balance`);
                continue;
            }

            // Calculate amount to keep (5% of balance) and amount to buy with
            const retentionAmount = balance * 0.05; // Fixed 5% retention
            let buyAmount = balance - retentionAmount;

            // Account for transaction fees to ensure we can actually keep 5%
            const TX_FEE = 0.000005; // Typical Solana tx fee
            buyAmount -= TX_FEE;

            // Ensure minimum transaction amount
            if (buyAmount < 0.000001) {
                console.log(`Skipping wallet #${i} - amount too small (${buyAmount.toFixed(6)} SOL)`);
                continue;
            }

            // Check if we would exceed pool size
            const currentPoolSize = await this.pumpFanService.getPoolSize(tokenAddress);
            const remainingSpace = MAX_POOL_SIZE - currentPoolSize;

            if (buyAmount > remainingSpace) {
                if (remainingSpace <= 0) {
                    console.log('Pool is full, stopping buys');
                    break;
                }
                buyAmount = remainingSpace;
            }

            console.log(`Wallet #${i} balance: ${balance.toFixed(6)} SOL`);
            console.log(`Keeping: ${retentionAmount.toFixed(6)} SOL (5%)`);
            console.log(`Buying: ${buyAmount.toFixed(6)} SOL`);
            
            let attempt = 0;
            while (attempt < MAX_RETRIES) {
                try {
                    const signature = await this.pumpFanService.buyToken({
                        tokenAddress,
                        buyerWallet: wallet,
                        amountInSol: buyAmount
                    });

                    await this.pumpFanService.waitForConfirmation(signature);
                    console.log(`Buy completed for wallet #${i}: ${signature}`);

                    totalBought += buyAmount;
                    failedAttempts = 0; // Reset failed attempts counter on success
                    
                    // Add delay between transactions
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    break; // Exit retry loop on success
                } catch (error) {
                    attempt++;
                    failedAttempts++;
                    console.error(`Error buying with wallet #${i} (attempt ${attempt}/${MAX_RETRIES}):`, error);
                    
                    if (attempt < MAX_RETRIES) {
                        // Increase delay with each retry
                        const delay = 2000 * (attempt + 1);
                        console.log(`Retrying in ${delay/1000} seconds...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }

                    // If we've had too many consecutive failures, take a longer break
                    if (failedAttempts >= 3) {
                        console.log('Too many consecutive failures, taking a longer break...');
                        await new Promise(resolve => setTimeout(resolve, 10000));
                        failedAttempts = 0;
                    }
                }
            }
        }

        console.log(`\nTotal bought: ${totalBought.toFixed(4)} SOL`);
    }
} 