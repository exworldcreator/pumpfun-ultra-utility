import { WalletService } from './services/WalletService';
import { TransactionService, IDistributionStateRepository, DistributionState } from './services/TransactionService';
import { TokenCreationService } from './services/TokenCreationService';

// Создаем заглушку для репозитория состояния
class DummyDistributionStateRepository implements IDistributionStateRepository {
    async saveState(state: DistributionState): Promise<void> {}
    async getState(userId: string): Promise<DistributionState | null> { return null; }
    async deleteState(userId: string): Promise<void> {}
}

async function main() {
    try {
        // Initialize services
        const walletService = await WalletService.initialize();
        const dummyRepository = new DummyDistributionStateRepository();
        const transactionService = new TransactionService(walletService, dummyRepository);
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