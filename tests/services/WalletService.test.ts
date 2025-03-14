import { WalletService } from '../../src/services/WalletService';
import { DatabaseService } from '../../src/services/DatabaseService';
import { Keypair } from '@solana/web3.js';
import * as sinon from 'sinon';
import { expect } from 'chai';
import { QueryResult, QueryResultRow } from 'pg';

describe('WalletService', () => {
  let walletService: WalletService;
  let dbServiceStub: sinon.SinonStubbedInstance<DatabaseService>;
  
  // Вспомогательная функция для создания объекта QueryResult
  function createQueryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
    return {
      rows,
      command: '',
      rowCount: rows.length,
      oid: 0,
      fields: []
    } as QueryResult<T>;
  }
  
  beforeEach(async () => {
    walletService = await WalletService.initialize();
    
    // Создаем заглушку для DatabaseService
    dbServiceStub = sinon.createStubInstance(DatabaseService);
    
    // Подменяем getInstance, чтобы возвращал нашу заглушку
    sinon.stub(DatabaseService, 'getInstance').returns(dbServiceStub as any);
    
    // Настраиваем заглушки для базы данных
    dbServiceStub.query.withArgs(sinon.match(/SELECT EXISTS/)).resolves(createQueryResult([{ exists: false }]));
  });
  
  afterEach(() => {
    sinon.restore();
  });
  
  describe('getWallet', () => {
    it('should return wallet if it exists in memory', async () => {
      // Создаем тестовый кошелек
      const testWallet = Keypair.generate();
      
      // Добавляем кошелек в память
      (walletService as any).wallets.set(1, testWallet);
      
      // Получаем кошелек
      const wallet = await walletService.getWallet(1);
      
      // Проверяем, что вернулся правильный кошелек
      expect(wallet).to.equal(testWallet);
    });
    
    it('should return null if wallet does not exist', async () => {
      // Очищаем кошельки
      (walletService as any).wallets.clear();
      
      // Настраиваем заглушку для базы данных
      dbServiceStub.query.withArgs(
        'SELECT * FROM wallets WHERE wallet_number = $1',
        [999]
      ).resolves(createQueryResult([]));
      
      // Получаем несуществующий кошелек
      const wallet = await walletService.getWallet(999);
      
      // Проверяем, что вернулся null
      expect(wallet).to.be.null;
    });
  });
  
  describe('getDevWallet', () => {
    it('should return dev wallet', () => {
      // Создаем тестовый кошелек
      const testWallet = Keypair.generate();
      
      // Устанавливаем dev кошелек
      (walletService as any).devWallet = testWallet;
      
      // Получаем dev кошелек
      const wallet = walletService.getDevWallet();
      
      // Проверяем, что вернулся правильный кошелек
      expect(wallet).to.equal(testWallet);
    });
  });
  
  describe('getDevWalletPublicKey', () => {
    it('should return dev wallet public key', () => {
      // Создаем тестовый кошелек
      const testWallet = Keypair.generate();
      const publicKeyString = testWallet.publicKey.toString();
      
      // Устанавливаем dev кошелек и его публичный ключ
      (walletService as any).devWallet = testWallet;
      (walletService as any).devWalletPublicKey = publicKeyString;
      
      // Получаем публичный ключ dev кошелька
      const publicKey = walletService.getDevWalletPublicKey();
      
      // Проверяем, что вернулся правильный публичный ключ
      expect(publicKey).to.equal(publicKeyString);
    });
  });
}); 