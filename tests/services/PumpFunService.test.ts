import { PumpFunService } from '../../src/services/PumpFunService';
import { WalletService } from '../../src/services/WalletService';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { expect } from 'chai';
import * as sinon from 'sinon';

describe('PumpFunService', () => {
  let pumpFunService: PumpFunService;
  let walletService: any;
  let connectionStub: sinon.SinonStubbedInstance<Connection>;
  let testWallet: Keypair;
  
  beforeEach(() => {
    // Создаем тестовый кошелек
    testWallet = Keypair.generate();
    
    // Создаем заглушку для WalletService
    walletService = {
      getDevWallet: sinon.stub().returns(testWallet),
      getWallet: sinon.stub().resolves(testWallet)
    };
    
    // Создаем заглушку для Connection
    connectionStub = sinon.createStubInstance(Connection);
    
    // Инициализируем PumpFunService с заглушками
    pumpFunService = new PumpFunService(walletService as WalletService);
    // Заменяем connection на нашу заглушку
    (pumpFunService as any).connection = connectionStub;
  });
  
  afterEach(() => {
    sinon.restore();
  });
  
  describe('buyTokens', () => {
    it('should successfully buy tokens', async () => {
      // Подготавливаем данные для теста
      const mint = new PublicKey('2EtjY21DhChgTGFpdDW2Amuok7jFbEReYSZ96ESyQXLo');
      const amountInSol = 0.1;
      const minTokenAmount = 50;
      
      // Настраиваем заглушки
      connectionStub.getAccountInfo.resolves(null); // ATA не существует
      connectionStub.getLatestBlockhash.resolves({ blockhash: 'test-blockhash', lastValidBlockHeight: 1000 });
      
      // Мокируем sendAndConfirmTransaction
      const sendAndConfirmTransactionStub = sinon.stub(require('@solana/web3.js'), 'sendAndConfirmTransaction')
        .resolves('test-signature');
      
      // Вызываем тестируемый метод
      const result = await pumpFunService.buyTokens(mint, amountInSol, minTokenAmount, testWallet);
      
      // Проверяем результат
      expect(result).to.equal('test-signature');
      expect(sendAndConfirmTransactionStub.calledOnce).to.be.true;
      
      // Проверяем, что транзакция содержит правильные инструкции
      const transaction = sendAndConfirmTransactionStub.args[0][1];
      expect(transaction.instructions.length).to.be.at.least(1);
    });
    
    it('should handle errors when buying tokens', async () => {
      // Подготавливаем данные для теста
      const mint = new PublicKey('2EtjY21DhChgTGFpdDW2Amuok7jFbEReYSZ96ESyQXLo');
      const amountInSol = 0.1;
      const minTokenAmount = 50;
      
      // Настраиваем заглушки для имитации ошибки
      connectionStub.getLatestBlockhash.resolves({ blockhash: 'test-blockhash', lastValidBlockHeight: 1000 });
      
      // Мокируем sendAndConfirmTransaction, чтобы он выбрасывал ошибку
      const error = new Error('Transaction simulation failed');
      sinon.stub(require('@solana/web3.js'), 'sendAndConfirmTransaction').rejects(error);
      
      // Проверяем, что метод выбрасывает ошибку
      try {
        await pumpFunService.buyTokens(mint, amountInSol, minTokenAmount, testWallet);
        expect.fail('Should have thrown an error');
      } catch (err: any) {
        expect(err.message).to.include('Failed to buy tokens');
      }
    });
  });
  
  describe('sellTokens', () => {
    it('should successfully sell tokens', async () => {
      // Подготавливаем данные для теста
      const mint = new PublicKey('2EtjY21DhChgTGFpdDW2Amuok7jFbEReYSZ96ESyQXLo');
      const tokenAmount = 100;
      
      // Настраиваем заглушки
      connectionStub.getAccountInfo.resolves({ data: Buffer.alloc(100), executable: false, lamports: 1000000, owner: new PublicKey('11111111111111111111111111111111') });
      connectionStub.getTokenAccountBalance.resolves({ 
        context: { slot: 1 },
        value: { amount: '100000000', decimals: 6, uiAmount: 100.0, uiAmountString: '100.0' } 
      });
      connectionStub.getLatestBlockhash.resolves({ blockhash: 'test-blockhash', lastValidBlockHeight: 1000 });
      
      // Мокируем sendAndConfirmTransaction
      const sendAndConfirmTransactionStub = sinon.stub(require('@solana/web3.js'), 'sendAndConfirmTransaction')
        .resolves('test-signature');
      
      // Вызываем тестируемый метод
      const result = await pumpFunService.sellTokens(mint, tokenAmount, testWallet);
      
      // Проверяем результат
      expect(result).to.equal('test-signature');
      expect(sendAndConfirmTransactionStub.calledOnce).to.be.true;
      
      // Проверяем, что транзакция содержит правильные инструкции
      const transaction = sendAndConfirmTransactionStub.args[0][1];
      expect(transaction.instructions.length).to.be.at.least(1);
    });
    
    it('should handle insufficient token balance', async () => {
      // Подготавливаем данные для теста
      const mint = new PublicKey('2EtjY21DhChgTGFpdDW2Amuok7jFbEReYSZ96ESyQXLo');
      const tokenAmount = 100;
      
      // Настраиваем заглушки для имитации недостаточного баланса
      connectionStub.getAccountInfo.resolves({ data: Buffer.alloc(100), executable: false, lamports: 1000000, owner: new PublicKey('11111111111111111111111111111111') });
      connectionStub.getTokenAccountBalance.resolves({ 
        context: { slot: 1 },
        value: { amount: '10000', decimals: 6, uiAmount: 0.01, uiAmountString: '0.01' } 
      });
      
      // Проверяем, что метод выбрасывает ошибку о недостаточном балансе
      try {
        await pumpFunService.sellTokens(mint, tokenAmount, testWallet);
        expect.fail('Should have thrown an error');
      } catch (err: any) {
        expect(err.message).to.include('Insufficient token balance');
      }
    });
  });
  
  describe('sellAllTokens', () => {
    it('should sell tokens from all wallets with balance', async () => {
      // Подготавливаем данные для теста
      const mint = new PublicKey('2EtjY21DhChgTGFpdDW2Amuok7jFbEReYSZ96ESyQXLo');
      
      // Создаем несколько тестовых кошельков
      const wallets = [
        Keypair.generate(), // wallet #1 с балансом
        Keypair.generate(), // wallet #2 без баланса
        Keypair.generate()  // wallet #3 с балансом
      ];
      
      // Настраиваем заглушку для WalletService
      const getWalletStub = walletService.getWallet;
      getWalletStub.withArgs(1).resolves(wallets[0]);
      getWalletStub.withArgs(2).resolves(wallets[1]);
      getWalletStub.withArgs(3).resolves(wallets[2]);
      getWalletStub.resolves(null); // Для остальных номеров кошельков
      
      // Настраиваем заглушки для имитации балансов токенов
      const getTokenAccountBalanceStub = connectionStub.getTokenAccountBalance;
      getTokenAccountBalanceStub.onFirstCall().resolves({ 
        context: { slot: 1 },
        value: { amount: '1000000', decimals: 6, uiAmount: 1.0, uiAmountString: '1.0' } 
      }); // wallet #1
      getTokenAccountBalanceStub.onSecondCall().rejects(new Error('Account not found')); // wallet #2
      getTokenAccountBalanceStub.onThirdCall().resolves({ 
        context: { slot: 1 },
        value: { amount: '500000', decimals: 6, uiAmount: 0.5, uiAmountString: '0.5' } 
      }); // wallet #3
      
      // Мокируем sellTokens
      const sellTokensStub = sinon.stub(pumpFunService, 'sellTokens');
      sellTokensStub.withArgs(mint, 1.0, wallets[0]).resolves('signature-1');
      sellTokensStub.withArgs(mint, 0.5, wallets[2]).resolves('signature-3');
      
      // Создаем мок для callback функции
      const progressCallback = sinon.stub().resolves();
      
      // Вызываем тестируемый метод
      const results = await pumpFunService.sellAllTokens(mint, progressCallback);
      
      // Проверяем результаты
      expect(results.length).to.equal(2); // Должно быть 2 результата (для кошельков #1 и #3)
      expect(results[0].walletNumber).to.equal(1);
      expect(results[0].signature).to.equal('signature-1');
      expect(results[1].walletNumber).to.equal(3);
      expect(results[1].signature).to.equal('signature-3');
      
      // Проверяем, что callback вызывался
      expect(progressCallback.called).to.be.true;
      
      // Проверяем, что sellTokens вызывался дважды
      expect(sellTokensStub.calledTwice).to.be.true;
    });

    it('should handle errors during token sale', async () => {
      // Подготавливаем данные для теста
      const mint = new PublicKey('2EtjY21DhChgTGFpdDW2Amuok7jFbEReYSZ96ESyQXLo');
      
      // Создаем тестовый кошелек
      const wallet = Keypair.generate();
      
      // Настраиваем заглушку для WalletService
      walletService.getWallet.withArgs(1).rejects(new Error('Failed to get wallet'));
      walletService.getWallet.withArgs(2).resolves(null);
      walletService.getWallet.withArgs(3).resolves(null);
      
      // Создаем мок для callback функции
      const progressCallback = sinon.stub().resolves();
      
      // Вызываем тестируемый метод
      const results = await pumpFunService.sellAllTokens(mint, progressCallback);
      
      // Проверяем результаты
      expect(results.length).to.equal(1); // Должен быть 1 результат с ошибкой
      expect(results[0].walletNumber).to.equal(1);
      expect(results[0].error).to.include('Failed to get wallet');
      
      // Проверяем, что callback вызывался
      expect(progressCallback.called).to.be.true;
    });
  });
}); 