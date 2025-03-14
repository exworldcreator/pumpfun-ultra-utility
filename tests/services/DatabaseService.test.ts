import { DatabaseService } from '../../src/services/DatabaseService';
import * as sinon from 'sinon';
import { expect } from 'chai';
import { Pool } from 'pg';

describe('DatabaseService', () => {
  let poolStub: sinon.SinonStubbedInstance<Pool>;
  
  beforeEach(() => {
    // Создаем заглушку для Pool
    poolStub = sinon.createStubInstance(Pool);
    
    // Подменяем конструктор Pool, чтобы возвращал нашу заглушку
    sinon.stub(Pool.prototype, 'constructor').returns(poolStub);
    
    // Очищаем синглтон DatabaseService
    (DatabaseService as any).instance = null;
  });
  
  afterEach(() => {
    sinon.restore();
  });
  
  describe('getInstance', () => {
    it('should create a new instance if one does not exist', () => {
      // Проверяем, что экземпляр не существует
      expect((DatabaseService as any).instance).to.be.null;
      
      // Получаем экземпляр
      const instance = DatabaseService.getInstance();
      
      // Проверяем, что экземпляр был создан
      expect(instance).to.be.an.instanceOf(DatabaseService);
      expect((DatabaseService as any).instance).to.equal(instance);
    });
    
    it('should return the existing instance if one exists', () => {
      // Создаем экземпляр
      const instance1 = DatabaseService.getInstance();
      
      // Получаем экземпляр еще раз
      const instance2 = DatabaseService.getInstance();
      
      // Проверяем, что вернулся тот же экземпляр
      expect(instance2).to.equal(instance1);
    });
  });
  
  describe('query', () => {
    it('should execute a query and return the result', async () => {
      // Создаем заглушку для результата запроса
      const queryResult = { rows: [{ id: 1, name: 'test' }], rowCount: 1 };
      poolStub.query.resolves(queryResult as any);
      
      // Получаем экземпляр DatabaseService
      const dbService = DatabaseService.getInstance();
      
      // Подменяем pool на нашу заглушку
      (dbService as any).pool = poolStub;
      
      // Выполняем запрос
      const result = await dbService.query('SELECT * FROM test');
      
      // Проверяем, что метод query был вызван с правильными аргументами
      expect(poolStub.query.calledWith('SELECT * FROM test')).to.be.true;
      
      // Проверяем, что вернулся правильный результат
      expect(result).to.equal(queryResult);
    });
    
    it('should execute a query with parameters and return the result', async () => {
      // Создаем заглушку для результата запроса
      const queryResult = { rows: [{ id: 1, name: 'test' }], rowCount: 1 };
      poolStub.query.resolves(queryResult as any);
      
      // Получаем экземпляр DatabaseService
      const dbService = DatabaseService.getInstance();
      
      // Подменяем pool на нашу заглушку
      (dbService as any).pool = poolStub;
      
      // Выполняем запрос с параметрами
      const result = await dbService.query('SELECT * FROM test WHERE id = $1', [1]);
      
      // Проверяем, что метод query был вызван с правильными аргументами
      expect(poolStub.query.calledWith('SELECT * FROM test WHERE id = $1', [1])).to.be.true;
      
      // Проверяем, что вернулся правильный результат
      expect(result).to.equal(queryResult);
    });
    
    it('should throw an error if the query fails', async () => {
      // Создаем заглушку для ошибки
      const error = new Error('Query failed');
      poolStub.query.rejects(error);
      
      // Получаем экземпляр DatabaseService
      const dbService = DatabaseService.getInstance();
      
      // Подменяем pool на нашу заглушку
      (dbService as any).pool = poolStub;
      
      // Выполняем запрос и проверяем, что он выбрасывает ошибку
      try {
        await dbService.query('SELECT * FROM test');
        expect.fail('Should have thrown an error');
      } catch (err) {
        expect(err).to.equal(error);
      }
    });
  });
  
  describe('getClient', () => {
    it('should get a client from the pool and return it', async () => {
      // Создаем заглушку для клиента
      const client = { query: sinon.stub(), release: sinon.stub() };
      poolStub.connect.resolves(client as any);
      
      // Получаем экземпляр DatabaseService
      const dbService = DatabaseService.getInstance();
      
      // Подменяем pool на нашу заглушку
      (dbService as any).pool = poolStub;
      
      // Получаем клиента
      const result = await dbService.getClient();
      
      // Проверяем, что метод connect был вызван
      expect(poolStub.connect.calledOnce).to.be.true;
      
      // Проверяем, что вернулся правильный клиент
      expect(result).to.equal(client);
    });
  });
}); 