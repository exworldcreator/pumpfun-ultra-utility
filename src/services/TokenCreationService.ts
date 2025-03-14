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
import { PumpFunService } from './PumpFunService';
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
    private pumpFunService: PumpFunService;
    private rl: readline.Interface;

    constructor(
        walletService: WalletService, 
        transactionService: TransactionService,
        rpcUrl: string = 'https://api.mainnet-beta.solana.com'
    ) {
        this.connection = new Connection(rpcUrl, 'confirmed');
        this.walletService = walletService;
        this.transactionService = transactionService;
        this.pumpFunService = new PumpFunService(walletService, rpcUrl);
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

            // Create token using PumpFunService
            console.log('\nCreating token...');
            const result = await this.pumpFunService.createTokenWithSteps({
                name: params.name,
                symbol: params.symbol,
                description: params.description,
                image: Buffer.from(params.picture), // Предполагаем, что picture - это base64 или URL изображения
                twitter: params.twitter || undefined,
                telegram: params.telegram || undefined,
                website: params.website || undefined,
                walletNumber: 0 // Используем dev wallet
            }, params.devBuyAmount);

            console.log(`Token created successfully! Mint address: ${result.mintAddress}`);
            console.log(`Transaction: ${result.solscanUrl}`);

            // Execute dev wallet buy if needed
            if (params.devBuyAmount > 0) {
                await this.executeDevWalletBuy(result.mintAddress, params.devBuyAmount);
            }

            // Execute bundle buys if needed
            if (params.bundleRetentionPercent > 0) {
                await this.executeBundleBuys(result.mintAddress, params);
            }

            return result.mintAddress;
        } catch (error) {
            console.error('Error in createAndBuyToken:', error);
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
        const devWallet = this.walletService.getWalletByIndex(0);
        if (!devWallet) {
            throw new Error('Dev wallet not found');
        }

        console.log(`Executing dev wallet buy for ${amount} SOL...`);
        const signature = await this.pumpFunService.buyTokens(
            new PublicKey(tokenAddress),
            amount,
            0, // minTokenAmount будет рассчитан внутри метода
            devWallet
        );

        await this.connection.confirmTransaction(signature, 'confirmed');
        console.log(`Dev wallet buy completed: ${signature}`);
    }

    private async executeBundleWalletBuys(tokenAddress: string, retentionPercent: number): Promise<void> {
        const MAX_RETRIES = 3;
        const MAX_POOL_SIZE = 1000; // Максимальный размер пула в SOL

        for (let i = 1; i <= 23; i++) {
            const wallet = await this.walletService.getWallet(i);
            if (!wallet) {
                console.log(`Wallet #${i} not found, skipping`);
                continue;
            }

            // Получаем баланс кошелька
            const balance = await this.connection.getBalance(wallet.publicKey);
            const solBalance = balance / LAMPORTS_PER_SOL;

            if (solBalance < 0.002) {
                console.log(`Wallet #${i} has insufficient balance (${solBalance} SOL), skipping`);
                continue;
            }

            // Рассчитываем сумму для покупки с учетом процента удержания
            const retentionAmount = (solBalance * retentionPercent) / 100;
            const reserveForFee = 0.001; // Минимальная сумма для комиссии
            const amountToKeep = Math.max(retentionAmount, reserveForFee);
            const buyAmount = solBalance - amountToKeep;

            console.log(`Bundle wallet #${i} balance calculation:`, {
                currentBalance: solBalance,
                retentionPercent,
                retentionAmount,
                reserveForFee,
                amountToKeep,
                amountToSpend: buyAmount,
                willBeLeft: amountToKeep
            });

            if (buyAmount <= 0) {
                console.log(`Wallet #${i} has insufficient balance after retention (${solBalance} SOL), skipping`);
                continue;
            }

            let attempt = 0;
            while (attempt < MAX_RETRIES) {
                try {
                    const signature = await this.pumpFunService.buyTokens(
                        new PublicKey(tokenAddress),
                        buyAmount,
                        0, // minTokenAmount будет рассчитан внутри метода
                        wallet
                    );

                    await this.connection.confirmTransaction(signature, 'confirmed');
                    console.log(`Buy completed for wallet #${i}: ${signature}`);
                    break;
                } catch (error) {
                    attempt++;
                    if (attempt === MAX_RETRIES) {
                        console.error(`Failed to buy tokens for wallet #${i} after ${MAX_RETRIES} attempts:`, error);
                    } else {
                        console.log(`Attempt ${attempt} failed for wallet #${i}, retrying...`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }
        }
    }
} 