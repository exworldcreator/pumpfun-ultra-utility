import { 
    Connection, 
    PublicKey, 
    SystemProgram, 
    TransactionInstruction, 
    Keypair, 
    VersionedTransaction, 
    TransactionMessage,
    SYSVAR_RENT_PUBKEY
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

export class TokenCreationService {
    private connection: Connection;
    private PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    private MINT_AUTHORITY = new PublicKey("AyY9zG2HAdy65CUXeU5vNE3cmTrz9VTNVLa1qoDcpump");
    private devWallet: Keypair | null = null;

    constructor() {
        this.connection = new Connection('https://mainnet.helius-rpc.com/?api-key=3a000b3a-3d3b-4e41-9b30-c75d439068f1', 'confirmed');
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
} 