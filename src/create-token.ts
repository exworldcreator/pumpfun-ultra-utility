import { WalletService } from './services/WalletService';
import { TransactionService } from './services/TransactionService';
import { TokenCreationService } from './services/TokenCreationService';

async function main() {
    try {
        // Initialize services
        const walletService = await WalletService.initialize();
        const transactionService = new TransactionService(walletService);
        const tokenCreationService = new TokenCreationService(
            walletService,
            transactionService
        );

        // Start token creation process
        const tokenUrl = await tokenCreationService.createAndBuyToken();
        console.log('\nProcess completed successfully! 🎉');
        console.log(`Token URL: ${tokenUrl}`);

    } catch (error) {
        console.error('Error in token creation process:', error);
        process.exit(1);
    }
}

main(); 