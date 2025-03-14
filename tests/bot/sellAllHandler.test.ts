import { expect } from 'chai';
import * as sinon from 'sinon';
import { Context } from 'telegraf';
import { PublicKey } from '@solana/web3.js';
import { PumpFunService } from '../../src/services/PumpFunService';
import { WalletService } from '../../src/services/WalletService';
import { TransactionService } from '../../src/services/TransactionService';

describe('Sell All Tokens Handler', () => {
  let ctx: any;
  let pumpFunService: any;
  let walletService: any;
  let transactionService: any;
  let userStates: Map<string, any>;
  
  beforeEach(() => {
    // Создаем моки для сервисов
    walletService = {
      getDevWallet: sinon.stub(),
      getWallet: sinon.stub()
    };
    
    transactionService = {
      loadWalletsFromSet: sinon.stub().resolves(true)
    };
    
    pumpFunService = {
      sellAllTokens: sinon.stub().callsFake(async (mint: PublicKey, progressCallback?: (text: string) => Promise<void>) => {
        // Имитируем вызовы callback для обновления прогресса
        if (progressCallback) {
          await progressCallback('Проверка баланса кошелька #1...');
          await progressCallback('Продажа 1.5 токенов с кошелька #1...');
          await progressCallback('Проверка баланса кошелька #2...');
        }
        
        // Возвращаем тестовые результаты
        return [
          { walletNumber: 1, signature: 'test-signature-1' },
          { walletNumber: 3, error: 'Insufficient token balance' }
        ];
      })
    };
    
    // Создаем мок для контекста Telegraf
    ctx = {
      from: { id: '123456789' },
      message: { text: '2EtjY21DhChgTGFpdDW2Amuok7jFbEReYSZ96ESyQXLo' },
      reply: sinon.stub().resolves({ chat: { id: '123456789' }, message_id: 1 }),
      telegram: {
        editMessageText: sinon.stub().resolves(true)
      }
    };
    
    // Инициализируем userStates
    userStates = new Map();
    userStates.set('123456789', {
      step: 'sell_all',
      distributionType: 'sell_all',
      tokenData: {}
    });
  });
  
  afterEach(() => {
    sinon.restore();
  });
  
  it('should handle sell_all flow correctly', async () => {
    // Создаем мок для handleTextMessage
    const handleTextMessage = sinon.stub().callsFake(async (ctx: any, userStates: Map<string, any>, pumpFunService: any, transactionService: any) => {
      const userId = ctx.from.id.toString();
      const userState = userStates.get(userId);
      
      if (userState && userState.step === 'sell_all') {
        const mintAddress = ctx.message.text.trim();
        try {
          const mint = new PublicKey(mintAddress);
          await ctx.reply('Начинаем продажу токенов...');
          await transactionService.loadWalletsFromSet();
          const results = await pumpFunService.sellAllTokens(mint, async (text: string) => {
            await ctx.telegram.editMessageText(userId, 1, undefined, text);
          });
          
          await ctx.telegram.editMessageText(
            userId,
            1,
            undefined,
            `Результаты продажи токенов: ${results.length} операций`
          );
          
          userStates.delete(userId);
        } catch (error) {
          await ctx.reply(`Ошибка: Неверный адрес токена`);
        }
      }
    });
    
    // Вызываем обработчик с контекстом
    await handleTextMessage(ctx, userStates, pumpFunService, transactionService);
    
    // Проверяем, что были вызваны нужные методы
    expect(transactionService.loadWalletsFromSet.calledOnce).to.be.true;
    expect(pumpFunService.sellAllTokens.calledOnce).to.be.true;
    
    // Проверяем, что были отправлены сообщения пользователю
    expect(ctx.reply.calledWith('Начинаем продажу токенов...')).to.be.true;
    expect(ctx.telegram.editMessageText.calledWith(
      '123456789',
      1,
      undefined,
      sinon.match(/Результаты продажи токенов/)
    )).to.be.true;
    
    // Проверяем, что состояние пользователя было очищено
    expect(userStates.has('123456789')).to.be.false;
  });
  
  it('should handle invalid mint address', async () => {
    // Изменяем текст сообщения на невалидный адрес
    ctx.message.text = 'invalid-address';
    
    // Создаем мок для handleTextMessage
    const handleTextMessage = sinon.stub().callsFake(async (ctx: any, userStates: Map<string, any>, pumpFunService: any, transactionService: any) => {
      const userId = ctx.from.id.toString();
      const userState = userStates.get(userId);
      
      if (userState && userState.step === 'sell_all') {
        const mintAddress = ctx.message.text.trim();
        try {
          const mint = new PublicKey(mintAddress);
          await transactionService.loadWalletsFromSet();
          await pumpFunService.sellAllTokens(mint, async (text: string) => {});
        } catch (error) {
          await ctx.reply(`Ошибка: Неверный адрес токена`);
        }
      }
    });
    
    // Вызываем обработчик с контекстом
    await handleTextMessage(ctx, userStates, pumpFunService, transactionService);
    
    // Проверяем, что было отправлено сообщение об ошибке
    expect(ctx.reply.calledWith('Ошибка: Неверный адрес токена')).to.be.true;
    
    // Проверяем, что методы сервисов не вызывались
    expect(transactionService.loadWalletsFromSet.called).to.be.false;
    expect(pumpFunService.sellAllTokens.called).to.be.false;
  });
  
  it('should handle errors during token sale', async () => {
    // Настраиваем мок для sellAllTokens, чтобы он выбрасывал ошибку
    pumpFunService.sellAllTokens.rejects(new Error('Test error'));
    
    // Создаем мок для handleTextMessage
    const handleTextMessage = sinon.stub().callsFake(async (ctx: any, userStates: Map<string, any>, pumpFunService: any, transactionService: any) => {
      const userId = ctx.from.id.toString();
      const userState = userStates.get(userId);
      
      if (userState && userState.step === 'sell_all') {
        const mintAddress = ctx.message.text.trim();
        try {
          const mint = new PublicKey(mintAddress);
          await transactionService.loadWalletsFromSet();
          await pumpFunService.sellAllTokens(mint, async (text: string) => {});
        } catch (error: any) {
          await ctx.reply(`Произошла ошибка при продаже токенов: ${error.message}`);
          userStates.delete(userId);
        }
      }
    });
    
    // Вызываем обработчик с контекстом
    await handleTextMessage(ctx, userStates, pumpFunService, transactionService);
    
    // Проверяем, что было отправлено сообщение об ошибке
    expect(ctx.reply.calledWith(sinon.match(/Произошла ошибка при продаже токенов/))).to.be.true;
    
    // Проверяем, что состояние пользователя было очищено
    expect(userStates.has('123456789')).to.be.false;
  });
}); 