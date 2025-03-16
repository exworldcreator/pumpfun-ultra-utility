import { Telegraf, Markup, Context } from 'telegraf';
import { Message, Update } from 'telegraf/typings/core/types/typegram';
import { WalletService } from '../services/WalletService';
import { TransactionService } from '../services/TransactionService';
import { WalletSetService } from '../services/WalletSetService';
import { PumpFunService } from '../services/PumpFunService';
import { TokenHistoryService } from '../services/TokenHistoryService';
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { Keypair, LAMPORTS_PER_SOL, SendTransactionError, Connection, PublicKey } from '@solana/web3.js';
import { message } from 'telegraf/filters';
import sharp from 'sharp';
import { DistributionStateRepository } from '../repositories/DistributionStateRepository';
import { DatabaseService } from '../services/DatabaseService';

// Константы программы Pump.fun
const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN must be provided in environment variables');
}

const bot = new Telegraf(process.env.BOT_TOKEN);
let walletService: WalletService;
let transactionService: TransactionService;
let walletSetService: WalletSetService;
let pumpFunService: PumpFunService;
let tokenHistoryService: TokenHistoryService;

// Инициализация сервисов
async function initializeServices() {
  walletService = await WalletService.initialize();
  
  // Получаем экземпляр DatabaseService
  const dbService = DatabaseService.getInstance();
  
  // Инициализируем репозиторий состояния распределения
  const distributionStateRepository = new DistributionStateRepository();
  await distributionStateRepository.initialize();
  
  transactionService = new TransactionService(walletService, distributionStateRepository);
  walletSetService = new WalletSetService();
  // Используем URL RPC из переменной окружения
  pumpFunService = new PumpFunService(walletService, process.env.RPC_URL);
  tokenHistoryService = new TokenHistoryService();
}

// Запускаем бота только после инициализации сервисов
async function startBot() {
  try {
    await initializeServices();
    
    // Обработчики команд бота
    // ... existing code ...
    
    // Запускаем бота
    bot.launch();
    
    // Enable graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    
    console.log('Bot started successfully');
  } catch (error) {
    console.error('Error starting bot:', error);
    process.exit(1);
  }
}

// Запускаем бота
startBot();

interface TokenData {
  name: string;
  symbol: string;
  description: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  picture?: Buffer;
  walletNumber?: number;
}

interface BundleTransaction {
  walletNumber: number;
  amount: number;
  signature?: string;
}

interface BundleData {
  retentionPercent: number;
  totalSol?: number;
  transactions?: BundleTransaction[];
  mintAddress?: string;
}

interface UserState {
  waitingForAmount?: boolean;
  distributionType?: 'bundle' | 'marketMakers' | 'checkBalance' | 'buyToken' | 'bundleBuy' | 'sell_all';
  useLookupTable?: boolean;
  step?: string;
  tokenData?: TokenData;
  mintAddress?: string;
  walletNumber?: number;
  bundleData?: BundleData;
}

type MessageContext = Context<Update> & {
  message: Update.New & Update.NonChannel & Message.TextMessage;
};

const userStates = new Map<string, UserState>();

// Add debug middleware to log all updates
bot.use((ctx, next) => {
  const update = ctx.update;
  console.log('Received update:', JSON.stringify(update, null, 2));
  if ('message' in update && 'text' in update.message) {
    console.log('Message text:', update.message.text);
    console.log('SELECT_SET button text:', WALLET_MENU_BUTTONS.SELECT_SET);
    console.log('Text match:', update.message.text === WALLET_MENU_BUTTONS.SELECT_SET);
  }
  return next();
});

// Main menu buttons
const MAIN_MENU_BUTTONS = {
  WALLETS: '👛 Wallets',
  LAUNCH: '🚀 Launch',
  EDIT_LAUNCH: '⚙️ Edit Launch'
};

// Submenu buttons for Wallets section
const WALLET_MENU_BUTTONS = {
  CREATE_WALLETS: '➕ Create Wallets',
  DISTRIBUTE_BUNDLE: '💰 Distribute Bundle',
  DISTRIBUTE_MARKET: '📊 Distribute Market Making',
  CHECK_BALANCE: '💳 Check Balance',
  DEV_WALLET: '🔑 Dev Wallet Info',
  WALLET_SETS: '📚 Wallet Sets',
  SELECT_SET: '🎯 Select Wallet Set',
  BACK: '⬅️ Back to Main Menu'
};

// Submenu buttons for Launch section
const LAUNCH_MENU_BUTTONS = {
  CREATE_TOKEN: '🪙 Create Token',
  BUY_TOKEN: '💸 Buy Token',
  SELL_ALL: '💰 Sell All Tokens',
  MY_TOKENS: '📜 My Tokens',
  BACK: '⬅️ Back to Main Menu'
};

// Submenu buttons for Edit Launch section
const EDIT_LAUNCH_MENU_BUTTONS = {
  TOGGLE_VOLUME: '📈 Toggle Volume',
  TOGGLE_BUYBACKS: '💫 Toggle Buybacks',
  MANAGE_LIQUIDITY: '💧 Manage Liquidity',
  BACK: '⬅️ Back to Main Menu'
};

// Helper function to create main menu keyboard
function getMainMenuKeyboard() {
  return Markup.keyboard([
    [MAIN_MENU_BUTTONS.WALLETS],
    [MAIN_MENU_BUTTONS.LAUNCH],
    [MAIN_MENU_BUTTONS.EDIT_LAUNCH]
  ]).resize();
}

// Helper function to create wallets submenu keyboard
function getWalletsMenuKeyboard() {
  return Markup.keyboard([
    [WALLET_MENU_BUTTONS.CREATE_WALLETS],
    [WALLET_MENU_BUTTONS.DISTRIBUTE_BUNDLE, WALLET_MENU_BUTTONS.DISTRIBUTE_MARKET],
    [WALLET_MENU_BUTTONS.CHECK_BALANCE, WALLET_MENU_BUTTONS.DEV_WALLET],
    [WALLET_MENU_BUTTONS.WALLET_SETS, WALLET_MENU_BUTTONS.SELECT_SET],
    [WALLET_MENU_BUTTONS.BACK]
  ]).resize();
}

// Helper function to create launch submenu keyboard
function getLaunchMenuKeyboard() {
  return Markup.keyboard([
    [LAUNCH_MENU_BUTTONS.CREATE_TOKEN],
    [LAUNCH_MENU_BUTTONS.BUY_TOKEN, LAUNCH_MENU_BUTTONS.SELL_ALL],
    [LAUNCH_MENU_BUTTONS.MY_TOKENS],
    [LAUNCH_MENU_BUTTONS.BACK]
  ]).resize();
}

// Helper function to create edit launch submenu keyboard
function getEditLaunchMenuKeyboard() {
  return Markup.keyboard([
    [EDIT_LAUNCH_MENU_BUTTONS.TOGGLE_VOLUME],
    [EDIT_LAUNCH_MENU_BUTTONS.TOGGLE_BUYBACKS],
    [EDIT_LAUNCH_MENU_BUTTONS.MANAGE_LIQUIDITY],
    [EDIT_LAUNCH_MENU_BUTTONS.BACK]
  ]).resize();
}

// Update start command to show main menu
bot.command('start', async (ctx) => {
  console.log('Received start command from:', ctx.from?.username);
  
  try {
    // Проверяем, инициализирован ли dev wallet
    let devWallet = walletService.getDevWallet();
    
    // Если dev wallet не инициализирован, предлагаем создать кошельки
    if (!devWallet) {
      console.log('Dev wallet not initialized. Suggesting wallet creation...');
      
      // Отправляем сообщение с предложением создать кошельки
      await ctx.reply(
        '👋 Добро пожаловать в PumpFun Bot!\n\n' +
        'Похоже, у вас еще нет кошельков. Для работы с ботом необходимо создать кошельки.\n\n' +
        'Используйте команду /create_wallets или нажмите кнопку "Создать кошельки" в меню управления кошельками.',
        getMainMenuKeyboard()
      );
      return;
    }
    
    // Send welcome message
    const welcomeMsg = '👋 Welcome to PumpFun Bot!\n\n' +
                      'This bot helps you manage wallets and launch tokens on Pump.fun.\n\n' +
                      '📍 Please select a section from the main menu below:';
    
    await ctx.reply(welcomeMsg, getMainMenuKeyboard());
    
  } catch (error) {
    console.error('Error in start command:', error);
    ctx.reply('❌ Error initializing bot. Please try again later.');
  }
});

// Handle main menu navigation
bot.hears(MAIN_MENU_BUTTONS.WALLETS, async (ctx) => {
  const message = '👛 <b>Wallets Management</b>\n\n' +
                  'Here you can:\n' +
                  '• Create new wallets\n' +
                  '• Distribute SOL to bundle wallets\n' +
                  '• Distribute SOL to market making wallets\n' +
                  '• Check wallet balances\n' +
                  '• View wallet sets\n\n' +
                  'Please select an action:';
  
  await ctx.reply(message, {
    parse_mode: 'HTML',
    ...getWalletsMenuKeyboard()
  });
});

bot.hears(MAIN_MENU_BUTTONS.LAUNCH, async (ctx) => {
  const message = '🚀 <b>Token Launch</b>\n\n' +
                  'Here you can:\n' +
                  '• Create new tokens\n' +
                  '• Buy existing tokens\n' +
                  '• Sell all tokens\n' +
                  '• View your tokens\n\n' +
                  'Please select an action:';
  
  await ctx.reply(message, {
    parse_mode: 'HTML',
    ...getLaunchMenuKeyboard()
  });
});

bot.hears(MAIN_MENU_BUTTONS.EDIT_LAUNCH, async (ctx) => {
  const message = '⚙️ <b>Launch Management</b>\n\n' +
                  'Here you can:\n' +
                  '• Toggle trading volume\n' +
                  '• Configure buybacks\n' +
                  '• Manage liquidity\n\n' +
                  'Please select an action:';
  
  await ctx.reply(message, {
    parse_mode: 'HTML',
    ...getEditLaunchMenuKeyboard()
  });
});

// Handle back button for all submenus
bot.hears([WALLET_MENU_BUTTONS.BACK, LAUNCH_MENU_BUTTONS.BACK, EDIT_LAUNCH_MENU_BUTTONS.BACK], async (ctx) => {
  const message = '📍 Main Menu\n\nPlease select a section:';
  await ctx.reply(message, getMainMenuKeyboard());
});

// Handle wallet menu buttons
bot.hears(WALLET_MENU_BUTTONS.CREATE_WALLETS, async (ctx) => {
  console.log('Received create wallets button click');
  
  try {
    // Проверяем, инициализирован ли dev wallet
    const devWallet = walletService.getDevWallet();
    
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('Yes, create with Lookup Tables', 'create_with_lut'),
        Markup.button.callback('No, just create wallets', 'create_without_lut')
      ]
    ]);
    
    let message = 'Do you want to create Lookup Tables along with the wallets?\n\n' +
                  'Lookup Tables allow for more efficient transactions but require SOL for creation.';
    
    if (devWallet) {
      // Если dev wallet уже инициализирован, проверяем баланс
      const balance = await transactionService.getWalletBalance(0);
      
      if (balance < 0.03) {
        message += '\n\n⚠️ Warning: Dev wallet has insufficient SOL for creating Lookup Tables.\n' +
                   `Current balance: ${balance.toFixed(4)} SOL\n` +
                   `Dev wallet address: ${devWallet.publicKey.toString()}\n` +
                   'Please fund this wallet with at least 0.03 SOL before creating Lookup Tables.';
      } else {
        message += `\n\nDev wallet balance: ${balance.toFixed(4)} SOL ✅`;
      }
    } else {
      // Если dev wallet не инициализирован, предупреждаем пользователя
      message += '\n\n⚠️ Note: Dev wallet will be created automatically.';
    }
    
    ctx.reply(message, keyboard);
  } catch (error) {
    console.error('Error in create_wallets button:', error);
    ctx.reply('❌ Error preparing wallet creation. Please try again later.');
  }
});

bot.hears(WALLET_MENU_BUTTONS.DISTRIBUTE_BUNDLE, async (ctx) => {
  console.log('Received distribute bundle button click');
  
  try {
    const devWallet = walletService.getDevWallet();
    if (!devWallet) {
      throw new Error('Dev wallet not initialized');
    }
    
    const balance = await transactionService.getWalletBalance(0);
    
    const bundlePayer = walletService.getWalletByIndex(24);
    if (!bundlePayer) {
      await ctx.reply('❌ Bundle payer wallet (#24) not found');
      return;
    }
    const bundleBalance = await transactionService.getBundlePayerBalance();
    
    await ctx.reply(
      '💰 Bundle Distribution\n\n' +
      'This will distribute SOL from the bundle payer wallet to bundle wallets.\n\n' +
      'Current status:\n' +
      `📝 Bundle payer wallet address: ${bundlePayer.publicKey.toString()}\n` +
      `💰 Balance: ${bundleBalance.toFixed(4)} SOL\n\n` +
      'Please enter the amount of SOL to distribute to each bundle wallet:'
    );

    // Set user state
    const userId = ctx.from?.id.toString() || '';
    userStates.set(userId, {
      waitingForAmount: true,
      distributionType: 'bundle'
    });
  } catch (error) {
    console.error('Error in distribute_bundle button:', error);
    ctx.reply('❌ Error preparing bundle distribution. Please try again later.');
  }
});

bot.hears(WALLET_MENU_BUTTONS.DISTRIBUTE_MARKET, async (ctx) => {
  try {
    if (transactionService.hasUnfinishedDistribution()) {
      const state = transactionService.getDistributionState();
      await ctx.reply(
        '⚠️ Обнаружено незавершенное распределение:\n\n' +
        `📝 Остановлено на кошельке #${state!.lastProcessedWallet}\n` +
        `💰 Осталось распределить: ${state!.remainingAmount.toFixed(4)} SOL\n\n` +
        'Выберите действие:',
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '▶️ Продолжить', callback_data: 'continue_distribution' },
                { text: '🔄 Начать заново', callback_data: 'restart_distribution' },
                { text: '❌ Отмена', callback_data: 'cancel_distribution' }
              ]
            ]
          }
        }
      );
      return;
    }

    console.log('Received distribute market button click');
    
    const devWallet = walletService.getDevWallet();
    if (!devWallet) {
      throw new Error('Dev wallet not initialized');
    }
    
    const balance = await transactionService.getWalletBalance(0);
    
    const marketMakingPayer = walletService.getWalletByIndex(25);
    if (!marketMakingPayer) {
      await ctx.reply('❌ Market making payer wallet (#25) not found');
      return;
    }
    const marketMakingBalance = await transactionService.getMarketMakingPayerBalance();
    
    await ctx.reply(
      '📊 Market Making Distribution\n\n' +
      'This will distribute SOL from the market making payer wallet to market making wallets.\n\n' +
      'Current status:\n' +
      `📝 Market making payer wallet address: ${marketMakingPayer.publicKey.toString()}\n` +
      `💰 Balance: ${marketMakingBalance.toFixed(4)} SOL\n\n` +
      'Please enter the amount of SOL to distribute to each market making wallet:'
    );
    
    // Set user state
    const userId = ctx.from?.id.toString() || '';
    userStates.set(userId, {
      waitingForAmount: true,
      distributionType: 'marketMakers'
    });
  } catch (error) {
    console.error('Error in distribute_market button:', error);
    ctx.reply('❌ Ошибка при подготовке распределения. Пожалуйста, попробуйте позже.');
  }
});

// Добавим обработчики для кнопок
bot.action('continue_distribution', async (ctx) => {
  try {
    const state = transactionService.getDistributionState();
    if (!state) {
      await ctx.reply('❌ Состояние распределения не найдено');
      return;
    }

    const message = await ctx.reply(
      `⏳ Продолжаем распределение с кошелька #${state.lastProcessedWallet + 1}...`
    );

    const signatures = await transactionService.distributeToMarketMakers(
      state.remainingAmount,
      ctx.from.id.toString(), // Добавляем ID пользователя
      false,
      async (text) => {
        try {
          await ctx.telegram.editMessageText(
            message.chat.id,
            message.message_id,
            undefined,
            text
          );
        } catch (error) {
          console.error('Error updating progress message:', error);
        }
      }
    );

    let resultMessage = '✅ Распределение успешно завершено!\n\n';
    resultMessage += 'Транзакции:\n';
    signatures.forEach((sig, index) => {
      resultMessage += `${index + 1}. https://solscan.io/tx/${sig}\n`;
    });

    await ctx.reply(resultMessage);
  } catch (error) {
    console.error('Error continuing distribution:', error);
    await ctx.reply(
      '❌ Ошибка при продолжении распределения:\n' +
      (error instanceof Error ? error.message : 'Неизвестная ошибка')
    );
  }
});

bot.action('restart_distribution', async (ctx) => {
  transactionService.resetDistributionState();
  await ctx.reply('🔄 Состояние сброшено. Используйте кнопку "Distribute Market Making" для начала нового распределения.');
});

bot.action('cancel_distribution', async (ctx) => {
  transactionService.resetDistributionState();
  await ctx.reply('❌ Распределение отменено');
});

bot.hears(WALLET_MENU_BUTTONS.CHECK_BALANCE, async (ctx) => {
  console.log('Received check balance button click');
  
  const userId = ctx.from?.id;
  if (!userId) return;

  userStates.set(userId.toString(), {
    waitingForAmount: true,
    distributionType: 'checkBalance',
    tokenData: createEmptyTokenData()
  });

  await ctx.reply(
    '💰 Поиск кошельков по балансу\n\n' +
    'Введите минимальную сумму SOL для поиска кошельков\n' +
    'Например, если вы введете "1.5", бот покажет все кошельки с балансом от 1.5 SOL и выше\n\n' +
    'Формат: число (например, "1.5" или "0.5")'
  );
});

bot.hears(WALLET_MENU_BUTTONS.DEV_WALLET, async (ctx) => {
  console.log('Received dev wallet button click');
  
  try {
    const devWallet = walletService.getDevWallet();
    if (!devWallet) {
      throw new Error('Dev wallet not initialized');
    }
    
    const balance = await transactionService.getWalletBalance(0);
    
    let message = '🔑 Dev Wallet Information:\n\n' +
                  `📝 Public Key: ${devWallet.publicKey.toString()}\n` +
                  `💰 Balance: ${balance.toFixed(4)} SOL\n\n`;
    
    if (balance < 0.03) {
      message += '⚠️ This wallet has insufficient SOL for creating Lookup Tables.\n' +
                 'Please fund this wallet with at least 0.03 SOL.\n\n' +
                 '💡 You can use:\n' +
                 '- Solana Faucet: https://faucet.solana.com\n' +
                 '- Transfer SOL from another wallet';
      } else {
      message += '✅ This wallet has sufficient SOL for creating Lookup Tables.';
    }
    
    ctx.reply(message);
  } catch (error) {
    console.error('Error in dev_wallet button:', error);
    ctx.reply('❌ Error checking dev wallet. Please try again later.');
  }
});

bot.hears(WALLET_MENU_BUTTONS.WALLET_SETS, async (ctx) => {
  console.log('Received wallet sets button click');
  
  try {
    const sets = walletSetService.getWalletSets();
    
    if (sets.length === 0) {
      ctx.reply('❌ Нет доступных наборов кошельков. Создайте новый набор с помощью кнопки "Create Wallets"');
      return;
    }

    const activeSetId = walletService.getActiveWalletSetId();
    let message = '📝 Доступные наборы кошельков:\n\n';
    
    sets.forEach(set => {
      const date = set.createdAt.toLocaleDateString('ru-RU');
      const isActive = set.id === activeSetId ? ' ✅' : '';
      message += `🔹 Набор ${set.id} (создан ${date})${isActive}\n`;
    });

    message += '\nДля выбора набора используйте команду /select_wallet_set <ID>';
    ctx.reply(message);
  } catch (error) {
    console.error('Error in wallet_sets button:', error);
    ctx.reply('❌ Ошибка при получении списка наборов. Пожалуйста, попробуйте позже.');
  }
});

bot.hears(WALLET_MENU_BUTTONS.SELECT_SET, async (ctx) => {
  console.log('Received select wallet set button click');
  
  try {
    const sets = walletSetService.getWalletSets();
    
    if (sets.length === 0) {
      ctx.reply('❌ Нет доступных наборов кошельков. Создайте новый набор с помощью кнопки "Create Wallets"');
      return;
    }

    const activeSetId = walletService.getActiveWalletSetId();
    const buttons = sets.map(set => {
      const date = set.createdAt.toLocaleDateString('ru-RU');
      const isActive = set.id === activeSetId ? ' ✅' : '';
      return [{
        text: `${set.id} (${date})${isActive}`,
        callback_data: `select_set_${set.id}`
      }];
    });

    await ctx.reply(
      '🎯 Выберите набор кошельков:\n\n' +
      'Текущий активный набор отмечен галочкой ✅',
      {
        reply_markup: {
          inline_keyboard: [
            ...buttons,
            [{
              text: '❌ Отмена',
              callback_data: 'cancel_select_set'
            }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Error in select set button:', error);
    ctx.reply('❌ Ошибка при получении списка наборов. Пожалуйста, попробуйте позже.');
  }
});

// Handle launch menu buttons
bot.hears(LAUNCH_MENU_BUTTONS.CREATE_TOKEN, async (ctx) => {
  console.log('Received create token button click');
  console.log('User ID:', ctx.from?.id);
  
  try {
    console.log('Setting up user state for token creation...');
    const userId = ctx.from.id.toString();
    userStates.set(userId, {
      step: 'wallet',
      tokenData: createEmptyTokenData()
    });
    
    console.log('User state initialized:', userStates.get(userId));

    await ctx.reply(
      '🪙 Создание нового токена\n\n' +
      'С какого кошелька вы хотите создать токен?\n' +
      'Введите номер кошелька (0-100):\n\n' +
      '0 - dev кошелек\n' +
      '1-23 - bundle кошельки\n' +
      '24 - bundle payer кошелек\n' +
      '25 - market making payer кошелек\n' +
      '26-100 - market making кошельки'
    );
    
    console.log('Launch command completed successfully');
    } catch (error) {
    console.error('Error in create_token button:', error);
    await ctx.reply('❌ Ошибка при запуске создания токена. Пожалуйста, попробуйте позже.');
  }
});

bot.hears(LAUNCH_MENU_BUTTONS.BUY_TOKEN, async (ctx) => {
  console.log('Received buy token button click');
  
  try {
    await ctx.reply(
      '🪙 Покупка токена на Pump.fun\n\n' +
      'Выберите режим покупки:',
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 Одиночная покупка', callback_data: 'buy_single' },
              { text: '💰 Выкупить токен', callback_data: 'buy_bundle' }
            ]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Error in buy_token button:', error);
    await ctx.reply('❌ Ошибка при запуске покупки. Пожалуйста, попробуйте позже.');
  }
});

bot.hears(LAUNCH_MENU_BUTTONS.SELL_ALL, async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    console.log('Sell All button clicked by user:', userId);

    await ctx.reply(
      '📝 Введите адрес токена (mint address) для продажи со всех кошельков:'
    );

    userStates.set(userId, {
      step: 'sell_all',
      distributionType: 'sell_all',
      tokenData: createEmptyTokenData()
    });
    
    console.log('User state set:', userStates.get(userId));
  } catch (error) {
    console.error('Error in sell_all button:', error);
    await ctx.reply('❌ Ошибка при инициализации продажи. Пожалуйста, попробуйте позже.');
  }
});

bot.hears(LAUNCH_MENU_BUTTONS.MY_TOKENS, async (ctx) => {
  console.log('Received my tokens button click');
  
  if (!ctx.from?.id) {
    await ctx.reply('❌ Ошибка: не удалось определить пользователя');
    return;
  }

  const userId = ctx.from.id;
  console.log(`User ${userId} requested their tokens`);
  
  try {
    const tokens = await tokenHistoryService.getUserTokens(userId);
    
    if (tokens.length === 0) {
      await ctx.reply('У вас пока нет созданных токенов. Используйте кнопку "Create Token", чтобы создать свой первый токен!');
      return;
    }
    
    const sortedTokens = [...tokens].sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    
    let message = '🪙 <b>Ваши созданные токены:</b>\n\n';
    
    sortedTokens.forEach((token, index) => {
      const date = new Date(token.createdAt);
      const dateStr = date.toLocaleDateString('ru-RU');
      const timeStr = date.toLocaleTimeString('ru-RU');
      
      message += `<b>${index + 1}. ${token.mintAddress}</b>\n`;
      message += `📅 Дата создания: ${dateStr} ${timeStr}\n`;
      message += `🔍 Статус: ${token.exists ? '✅ Существует' : '❓ Не подтвержден'}\n`;
      message += `🔗 <a href="${token.solscanUrl}">Просмотреть на Solscan</a>\n\n`;
    });
    
    message += 'Используйте кнопку "Create Token", чтобы создать новый токен!';
    
    await ctx.telegram.sendMessage(ctx.chat.id, message, {
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('Error fetching user tokens:', error);
    await ctx.reply('❌ Произошла ошибка при получении списка ваших токенов. Пожалуйста, попробуйте позже.');
  }
});

// Placeholder handlers for Edit Launch section (to be implemented)
bot.hears(EDIT_LAUNCH_MENU_BUTTONS.TOGGLE_VOLUME, async (ctx) => {
  await ctx.reply('🔧 Volume management feature is coming soon!');
});

bot.hears(EDIT_LAUNCH_MENU_BUTTONS.TOGGLE_BUYBACKS, async (ctx) => {
  await ctx.reply('🔧 Buybacks management feature is coming soon!');
});

bot.hears(EDIT_LAUNCH_MENU_BUTTONS.MANAGE_LIQUIDITY, async (ctx) => {
  await ctx.reply('🔧 Liquidity management feature is coming soon!');
});

// Dev wallet command
bot.command('dev_wallet', async (ctx) => {
  console.log('Received dev_wallet command from:', ctx.from?.username);
  
  try {
    const devWallet = walletService.getDevWallet();
    if (!devWallet) {
      throw new Error('Dev wallet not initialized');
    }
    
    const balance = await transactionService.getWalletBalance(0);
    
    let message = '🔑 Dev Wallet Information:\n\n' +
                  `📝 Public Key: ${devWallet.publicKey.toString()}\n` +
                  `💰 Balance: ${balance.toFixed(4)} SOL\n\n`;
    
    if (balance < 0.03) {
      message += '⚠️ This wallet has insufficient SOL for creating Lookup Tables.\n' +
                 'Please fund this wallet with at least 0.03 SOL.\n\n' +
                 '💡 You can use:\n' +
                 '- Solana Faucet: https://faucet.solana.com\n' +
                 '- Transfer SOL from another wallet';
    } else {
      message += '✅ This wallet has sufficient SOL for creating Lookup Tables.';
    }
    
    ctx.reply(message);
  } catch (error) {
    console.error('Error in dev_wallet command:', error);
    ctx.reply('❌ Error checking dev wallet. Please try again later.');
  }
});

// Create wallets command
bot.command('create_wallets', async (ctx) => {
  console.log('Received create_wallets command from:', ctx.from?.username);
  
  try {
    // Проверяем, инициализирован ли dev wallet
    const devWallet = walletService.getDevWallet();
    
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('Yes, create with Lookup Tables', 'create_with_lut'),
        Markup.button.callback('No, just create wallets', 'create_without_lut')
      ]
    ]);
    
    let message = 'Do you want to create Lookup Tables along with the wallets?\n\n' +
                  'Lookup Tables allow for more efficient transactions but require SOL for creation.';
    
    if (devWallet) {
      // Если dev wallet уже инициализирован, проверяем баланс
      const balance = await transactionService.getWalletBalance(0);
      
      if (balance < 0.03) {
        message += '\n\n⚠️ Warning: Dev wallet has insufficient SOL for creating Lookup Tables.\n' +
                   `Current balance: ${balance.toFixed(4)} SOL\n` +
                   `Dev wallet address: ${devWallet.publicKey.toString()}\n` +
                   'Please fund this wallet with at least 0.03 SOL before creating Lookup Tables.';
      } else {
        message += `\n\nDev wallet balance: ${balance.toFixed(4)} SOL ✅`;
      }
    } else {
      // Если dev wallet не инициализирован, предупреждаем пользователя
      message += '\n\n⚠️ Note: Dev wallet will be created automatically.';
    }
    
    ctx.reply(message, keyboard);
  } catch (error) {
    console.error('Error in create_wallets command:', error);
    ctx.reply('❌ Error preparing wallet creation. Please try again later.');
  }
});

// Handle wallet creation choice
bot.action(/create_(with|without)_lut/, async (ctx) => {
  const createWithLUT = ctx.match[1] === 'with';
  
  try {
    // Проверяем, инициализирован ли dev wallet
    const devWallet = walletService.getDevWallet();
    
    // Если dev wallet инициализирован и запрошено создание LUT, проверяем баланс
    if (devWallet && createWithLUT) {
      const balance = await transactionService.getWalletBalance(0);
      
      if (balance < 0.03) {
        ctx.reply(`⚠️ Warning: Dev wallet has insufficient SOL for creating Lookup Tables.\n` +
                  `Current balance: ${balance.toFixed(4)} SOL\n` +
                  `Dev wallet address: ${devWallet.publicKey.toString()}\n\n` +
                  `Proceeding with wallet creation, but Lookup Tables will not be created.\n` +
                  `Please fund the dev wallet and try again later.`);
        
        const result = await walletService.generateWallets(false);
        await handleWalletCreationResult(ctx, result, true);
        return;
      }
    }
    
    // Отправляем начальное сообщение
    const initialMessage = await ctx.reply(
      `🔄 Начинаю процесс генерации кошельков${createWithLUT ? ' с Lookup Tables' : ''}...\n` +
      'Это может занять несколько минут...'
    );
    
    // Создаем обработчик прогресса
    let progressMessage: any = initialMessage;
    let lastUpdateTime = Date.now();
    
    // Функция для обновления сообщения о прогрессе
    const updateProgress = async (message: string) => {
      // Обновляем сообщение не чаще чем раз в 2 секунды
      const now = Date.now();
      if (now - lastUpdateTime < 2000) {
        return;
      }
      lastUpdateTime = now;
      
      try {
        progressMessage = await ctx.telegram.editMessageText(
          ctx.chat!.id,
          progressMessage.message_id,
          undefined,
          message
        );
      } catch (error) {
        console.error('Error updating progress message:', error);
      }
    };
    
    // Обновляем сообщение о прогрессе
    if (createWithLUT) {
      await updateProgress(
        '🔄 Генерация кошельков...\n' +
        '⏳ Шаг 1/5: Создание 101 кошелька Solana'
      );
    } else {
      await updateProgress(
        '🔄 Генерация кошельков...\n' +
        '⏳ Шаг 1/2: Создание 101 кошелька Solana'
      );
    }
    
    // Устанавливаем обработчики событий для LookupTableService
    const originalConsoleLog = console.log;
    if (createWithLUT) {
      // Подписываемся на события LookupTableService
      console.log = function(...args) {
        originalConsoleLog.apply(console, args);
        
        const message = args.join(' ');
        
        if (message.includes('Creating bundle lookup table')) {
          updateProgress(
            '🔄 Генерация кошельков...\n' +
            '✅ Шаг 1/5: Создание 101 кошелька Solana - Завершено\n' +
            '⏳ Шаг 2/5: Создание Lookup Table для bundle кошельков'
          );
        } else if (message.includes('Created lookup table') && message.includes('bundle')) {
          updateProgress(
            '🔄 Генерация кошельков...\n' +
            '✅ Шаг 1/5: Создание 101 кошелька Solana - Завершено\n' +
            '✅ Шаг 2/5: Создание Lookup Table для bundle кошельков - Завершено\n' +
            '⏳ Шаг 3/5: Добавление адресов в Lookup Table для bundle кошельков'
          );
        } else if (message.includes('Extended lookup table') && message.includes('bundle')) {
          updateProgress(
            '🔄 Генерация кошельков...\n' +
            '✅ Шаг 1/5: Создание 101 кошелька Solana - Завершено\n' +
            '✅ Шаг 2/5: Создание Lookup Table для bundle кошельков - Завершено\n' +
            '✅ Шаг 3/5: Добавление адресов в Lookup Table для bundle кошельков - Завершено\n' +
            '⏳ Шаг 4/5: Создание Lookup Table для market making кошельков'
          );
        } else if (message.includes('Creating market_making lookup table')) {
          updateProgress(
            '🔄 Генерация кошельков...\n' +
            '✅ Шаг 1/5: Создание 101 кошелька Solana - Завершено\n' +
            '✅ Шаг 2/5: Создание Lookup Table для bundle кошельков - Завершено\n' +
            '✅ Шаг 3/5: Добавление адресов в Lookup Table для bundle кошельков - Завершено\n' +
            '⏳ Шаг 4/5: Создание Lookup Table для market making кошельков'
          );
        } else if (message.includes('Created lookup table') && message.includes('market')) {
          updateProgress(
            '🔄 Генерация кошельков...\n' +
            '✅ Шаг 1/5: Создание 101 кошелька Solana - Завершено\n' +
            '✅ Шаг 2/5: Создание Lookup Table для bundle кошельков - Завершено\n' +
            '✅ Шаг 3/5: Добавление адресов в Lookup Table для bundle кошельков - Завершено\n' +
            '✅ Шаг 4/5: Создание Lookup Table для market making кошельков - Завершено\n' +
            '⏳ Шаг 5/5: Добавление адресов в Lookup Table для market making кошельков'
          );
        } else if (message.includes('Extended lookup table') && message.includes('market')) {
          updateProgress(
            '🔄 Генерация кошельков...\n' +
            '✅ Шаг 1/5: Создание 101 кошелька Solana - Завершено\n' +
            '✅ Шаг 2/5: Создание Lookup Table для bundle кошельков - Завершено\n' +
            '✅ Шаг 3/5: Добавление адресов в Lookup Table для bundle кошельков - Завершено\n' +
            '✅ Шаг 4/5: Создание Lookup Table для market making кошельков - Завершено\n' +
            '⏳ Шаг 5/5: Добавление адресов в Lookup Table для market making кошельков'
          );
        } else if (message.includes('Saving wallets to database')) {
          updateProgress(
            '🔄 Генерация кошельков...\n' +
            '✅ Шаг 1/5: Создание 101 кошелька Solana - Завершено\n' +
            '✅ Шаг 2/5: Создание Lookup Table для bundle кошельков - Завершено\n' +
            '✅ Шаг 3/5: Добавление адресов в Lookup Table для bundle кошельков - Завершено\n' +
            '✅ Шаг 4/5: Создание Lookup Table для market making кошельков - Завершено\n' +
            '✅ Шаг 5/5: Добавление адресов в Lookup Table для market making кошельков - Завершено\n' +
            '⏳ Сохранение кошельков в базу данных...'
          );
        } else if (message.includes('Wallets generated, sending file')) {
          updateProgress(
            '🔄 Генерация кошельков...\n' +
            '✅ Шаг 1/5: Создание 101 кошелька Solana - Завершено\n' +
            '✅ Шаг 2/5: Создание Lookup Table для bundle кошельков - Завершено\n' +
            '✅ Шаг 3/5: Добавление адресов в Lookup Table для bundle кошельков - Завершено\n' +
            '✅ Шаг 4/5: Создание Lookup Table для market making кошельков - Завершено\n' +
            '✅ Шаг 5/5: Добавление адресов в Lookup Table для market making кошельков - Завершено\n' +
            '✅ Сохранение кошельков в базу данных - Завершено\n' +
            '📤 Отправка файла с кошельками...'
          );
        }
      };
    }
    
    // Генерируем кошельки
    const result = await walletService.generateWallets(createWithLUT);
    
    // Восстанавливаем оригинальную функцию console.log
    if (createWithLUT) {
      console.log = originalConsoleLog;
    }
    
    // Обновляем сообщение о завершении
    if (createWithLUT) {
      await updateProgress(
        '✅ Генерация кошельков успешно завершена!\n' +
        '✅ Шаг 1/5: Создание 101 кошелька Solana - Завершено\n' +
        '✅ Шаг 2/5: Создание Lookup Table для bundle кошельков - Завершено\n' +
        '✅ Шаг 3/5: Добавление адресов в Lookup Table для bundle кошельков - Завершено\n' +
        '✅ Шаг 4/5: Создание Lookup Table для market making кошельков - Завершено\n' +
        '✅ Шаг 5/5: Добавление адресов в Lookup Table для market making кошельков - Завершено\n' +
        '✅ Сохранение кошельков в базу данных - Завершено\n' +
        '📤 Отправка файла с кошельками...'
      );
    } else {
      await updateProgress(
        '✅ Генерация кошельков успешно завершена!\n' +
        '✅ Шаг 1/2: Создание 101 кошелька Solana - Завершено\n' +
        '✅ Шаг 2/2: Сохранение кошельков в базу данных - Завершено\n' +
        '📤 Отправка файла с кошельками...'
      );
    }
    
    // Обрабатываем результат
    await handleWalletCreationResult(ctx, result, createWithLUT);
  } catch (error) {
    console.error('Error generating wallets:', error);
    ctx.reply('❌ Error generating wallets. Please try again later.');
  }
});

// Helper function to handle wallet creation result
async function handleWalletCreationResult(ctx: any, result: any, requestedLUT: boolean) {
  console.log('Wallets generated, sending file:', result.csvFilePath);
  
  await ctx.replyWithDocument({ 
    source: fs.createReadStream(result.csvFilePath),
    filename: 'wallets.csv'
  });

  if (result.bundleLUT && result.marketMakingLUT) {
    console.log('Setting LUT addresses:', result.bundleLUT, result.marketMakingLUT);
    transactionService.setLookupTableAddresses(result.bundleLUT, result.marketMakingLUT);
  }

  // Load wallets into TransactionService
  console.log('Loading wallets into TransactionService...');
  // Wallets are already loaded automatically
  
  // Create new wallet set
  const wallets = await parseWalletsCsv(result.csvFilePath);
  const setId = await walletSetService.createWalletSet(wallets);

  fs.unlinkSync(result.csvFilePath);
  console.log('File sent and deleted successfully');
  
  let message = '✅ Кошельки успешно созданы!\n\n' +
                `📝 Набор кошельков: ${setId}\n` +
                '📝 Кошелек #0 - dev кошелек\n' +
                '📝 Кошельки #1-23 - bundle кошельки\n' +
                '📝 Кошелек #24 - bundle payer кошелек\n' +
                '📝 Кошелек #25 - market making payer кошелек\n' +
                '📝 Кошельки #26-100 - market making кошельки';
  
  if (requestedLUT && result.bundleLUT && result.marketMakingLUT) {
    message += '\n\n📊 Lookup Tables созданы:\n' +
               `📝 Bundle Lookup Table: ${result.bundleLUT}\n` +
               `📝 Market Making Lookup Table: ${result.marketMakingLUT}`;
  } else if (requestedLUT && result.error) {
    message += '\n\n⚠️ Предупреждение: ' + result.error;
    
    if (result.error.includes('has no SOL to pay')) {
      message += '\n\n📝 Для создания Lookup Tables пополните баланс dev кошелька и попробуйте снова.\n' +
                 `📝 Адрес dev кошелька: ${walletService.getDevWallet()?.publicKey.toString()}\n` +
                 '📝 Вы можете использовать Solana Faucet или перевести SOL с другого кошелька.';
    }
  }
  
  ctx.reply(message);
}

// Helper function to parse wallets CSV
async function parseWalletsCsv(csvFilePath: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const wallets: any[] = [];
    fs.createReadStream(csvFilePath)
      .pipe(require('csv-parser')())
      .on('data', (data: any) => wallets.push(data))
      .on('end', () => resolve(wallets))
      .on('error', reject);
  });
}

// Wallet sets command
bot.command('wallet_sets', async (ctx) => {
  try {
    const sets = walletSetService.getWalletSets();
    
    if (sets.length === 0) {
      ctx.reply('❌ Нет доступных наборов кошельков. Создайте новый набор с помощью команды /create_wallets');
      return;
    }

    const activeSetId = walletService.getActiveWalletSetId();
    let message = '📝 Доступные наборы кошельков:\n\n';
    
    sets.forEach(set => {
      const date = set.createdAt.toLocaleDateString('ru-RU');
      const isActive = set.id === activeSetId ? ' ✅' : '';
      message += `🔹 Набор ${set.id} (создан ${date})${isActive}\n`;
    });

    message += '\nДля выбора набора используйте команду /select_wallet_set <ID>';
    ctx.reply(message);
  } catch (error) {
    console.error('Error in wallet_sets command:', error);
    ctx.reply('❌ Ошибка при получении списка наборов. Пожалуйста, попробуйте позже.');
  }
});

// Initialize empty TokenData
function createEmptyTokenData(): TokenData {
  return {
    name: '',
    symbol: '',
    description: '',
  };
}

// Bundle distribution command
bot.command('distribute_bundle', async (ctx) => {
  console.log('Received distribute_bundle command from:', ctx.from?.username);
  
  try {
    const devWallet = walletService.getDevWallet();
    if (!devWallet) {
      throw new Error('Dev wallet not initialized');
    }
    
    // Ensure wallets are loaded from the most recent set
    await transactionService.loadWalletsFromSet();
    
    const balance = await transactionService.getWalletBalance(24); // Check payer wallet balance
    
    await ctx.reply(
      'Распределение SOL на bundle кошельки\n\n' +
      `💰 Баланс кошелька #24: ${balance.toFixed(4)} SOL\n\n` +
      'Введите сумму SOL для распределения:'
    );

    userStates.set(ctx.from.id.toString(), {
      waitingForAmount: true,
      distributionType: 'bundle',
      tokenData: createEmptyTokenData()
    });
  } catch (error) {
    console.error('Error in distribute_bundle command:', error);
    ctx.reply('❌ Ошибка при проверке баланса. Пожалуйста, попробуйте позже.');
  }
});

// Market makers distribution command
bot.command('distribute_market', async (ctx) => {
  try {
    if (transactionService.hasUnfinishedDistribution()) {
      const state = transactionService.getDistributionState();
      await ctx.reply(
        '⚠️ Обнаружено незавершенное распределение:\n\n' +
        `📝 Остановлено на кошельке #${state!.lastProcessedWallet}\n` +
        `💰 Осталось распределить: ${state!.remainingAmount.toFixed(4)} SOL\n\n` +
        'Выберите действие:',
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '▶️ Продолжить', callback_data: 'continue_distribution' },
                { text: '🔄 Начать заново', callback_data: 'restart_distribution' },
                { text: '❌ Отмена', callback_data: 'cancel_distribution' }
              ]
            ]
          }
        }
      );
      return;
    }

    console.log('Received distribute_market command from:', ctx.from?.username);
    
    const devWallet = walletService.getDevWallet();
    if (!devWallet) {
      throw new Error('Dev wallet not initialized');
    }
    
    // Ensure wallets are loaded from the most recent set
    await transactionService.loadWalletsFromSet();
    
    const balance = await transactionService.getWalletBalance(25); // Check payer wallet balance
    
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('С Lookup Table', 'distribute_with_lut'),
        Markup.button.callback('Без Lookup Table', 'distribute_without_lut')
      ]
    ]);
    
    await ctx.reply(
      'Распределение SOL на market making кошельки\n\n' +
      `💰 Баланс кошелька #25: ${balance.toFixed(4)} SOL\n\n` +
      'Выберите способ распределения:',
      keyboard
    );
  } catch (error) {
    console.error('Error in distribute_market command:', error);
    ctx.reply('❌ Ошибка при подготовке распределения. Пожалуйста, попробуйте позже.');
  }
});

// Handle market making distribution choice
bot.action(/distribute_(with|without)_lut/, async (ctx) => {
  const useTable = ctx.match[1] === 'with';
  const userId = ctx.from?.id.toString();
  
  if (!userId) {
    await ctx.reply('❌ Ошибка: не удалось определить пользователя');
    return;
  }

  userStates.set(userId, {
    waitingForAmount: true,
    distributionType: 'marketMakers',
    useLookupTable: useTable,
    tokenData: createEmptyTokenData()
  });

  await ctx.reply('Введите сумму SOL для распределения:');
});

// Launch command
bot.command('launch', async (ctx) => {
  console.log('Received /launch command from:', ctx.from?.username);
  console.log('User ID:', ctx.from?.id);
  
  try {
    console.log('Setting up user state for token creation...');
    const userId = ctx.from.id.toString();
    userStates.set(userId, {
      step: 'wallet',
      tokenData: createEmptyTokenData()
    });
    
    console.log('User state initialized:', userStates.get(userId));

    await ctx.reply(
      '🪙 Создание нового токена\n\n' +
      'С какого кошелька вы хотите создать токен?\n' +
      'Введите номер кошелька (0-100):\n\n' +
      '0 - dev кошелек\n' +
      '1-23 - bundle кошельки\n' +
      '24 - bundle payer кошелек\n' +
      '25 - market making payer кошелек\n' +
      '26-100 - market making кошельки'
    );
    
    console.log('Launch command completed successfully');
  } catch (error) {
    console.error('Error in launch command:', error);
    await ctx.reply('❌ Ошибка при запуске создания токена. Пожалуйста, попробуйте позже.');
  }
});

// Buy token command
bot.command('buytoken', async (ctx) => {
  console.log('Received buytoken command from:', ctx.from?.username);
  
  try {
    await ctx.reply(
      '🪙 Покупка токена на Pump.fun\n\n' +
      'Выберите режим покупки:',
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 Одиночная покупка', callback_data: 'buy_single' },
              { text: '💰 Выкупить токен', callback_data: 'buy_bundle' }
            ]
          ]
        }
      }
    );

  } catch (error) {
    console.error('Error in buytoken command:', error);
    await ctx.reply('❌ Ошибка при запуске покупки. Пожалуйста, попробуйте позже.');
  }
});

// Handle buy mode selection
bot.action(/buy_(single|bundle)/, async (ctx) => {
  const mode = ctx.match[1];
  const userId = ctx.from?.id.toString();
  if (!userId) {
    await ctx.reply('❌ Ошибка: не удалось определить пользователя');
    return;
  }

  if (mode === 'single') {
    await ctx.reply(
      '🪙 Покупка токена на Pump.fun\n\n' +
      'С какого кошелька вы хотите купить токен?\n' +
      'Введите номер кошелька (0-100):\n\n' +
      '0 - dev кошелек\n' +
      '1-23 - bundle кошельки\n' +
      '24 - bundle payer кошелек\n' +
      '25 - market making payer кошелек\n' +
      '26-100 - market making кошельки'
    );

    userStates.set(userId, {
      distributionType: 'buyToken',
      step: 'wallet'
    });
  } else {
    await ctx.reply(
      '📦 Bundle покупка токена\n\n' +
      'Введите адрес токена (mint address):'
    );

    userStates.set(userId, {
      distributionType: 'bundleBuy',
      step: 'mint',
      bundleData: {
        retentionPercent: 0,
        totalSol: 0,
        transactions: []
      }
    });
  }
});

// Update message handler for bundle purchase
bot.on('text', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId) return;

  const userState = userStates.get(userId);
  if (!userState) return;

  console.log('Processing text message. Current user state:', userState);

  try {
    // Handle bundle purchase flow
    if (userState.distributionType === 'bundleBuy') {
      switch (userState.step) {
        case 'mint':
          try {
            const mintAddress = ctx.message.text.trim();
            new PublicKey(mintAddress); // Validate mint address

            userState.bundleData = {
              ...userState.bundleData!,
              mintAddress
            };

            // Формируем сообщение с предварительной информацией
            let message = '📝 Проверьте данные для bundle покупки:\n\n';
            message += `🔹 Токен: ${mintAddress}\n`;
            message += 'Будут использованы кошельки 0-23 с балансом > 0\n';
            message += 'Каждому кошельку будет оставлено 0.001 SOL на комиссию';

            await ctx.reply(message, {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '✅ Подтвердить', callback_data: 'confirm_bundle' },
                    { text: '❌ Отменить', callback_data: 'cancel_bundle' }
                  ]
                ]
              }
            });

            userState.step = '';
          } catch (error) {
            await ctx.reply('❌ Некорректный адрес токена. Пожалуйста, проверьте адрес и попробуйте снова.');
          }
          break;
      }
      return;
    }

    // Handle test token buying flow
    if (userState.distributionType === 'buyToken') {
      switch (userState.step) {
        case 'wallet':
          const walletNumber = parseInt(ctx.message.text);
          if (isNaN(walletNumber) || walletNumber < 0 || walletNumber > 100) {
            await ctx.reply('❌ Некорректный номер кошелька. Пожалуйста, введите число от 0 до 100.');
            return;
          }

          try {
            // Проверяем существование кошелька
            const loadingMsg = await ctx.reply('⏳ Проверка кошелька...');
            
            // Загружаем кошельки из последнего доступного набора
            await transactionService.loadWalletsFromSet();
            
            // Проверяем баланс кошелька
            const balance = await transactionService.getWalletBalance(walletNumber);
            const wallet = await walletService.getWallet(walletNumber);
            
            if (!wallet) {
              await ctx.telegram.editMessageText(
                loadingMsg.chat.id,
                loadingMsg.message_id,
                undefined,
                '❌ Ошибка: кошелек не найден'
              );
              return;
            }

            // Сохраняем номер кошелька в состоянии
            userStates.set(userId, {
              ...userState,
              walletNumber,
              step: 'mint'
            });

            let message = `✅ Выбран кошелек #${walletNumber}\n`;
            message += `📝 Адрес: ${wallet.publicKey.toString()}\n`;
            message += `💰 Баланс: ${balance.toFixed(4)} SOL\n\n`;
            message += 'Теперь введите адрес токена (mint address):';
            
            await ctx.telegram.editMessageText(
              loadingMsg.chat.id,
              loadingMsg.message_id,
              undefined,
              message
            );
          } catch (error) {
            console.error('Error checking wallet:', error);
            await ctx.reply('❌ Ошибка при проверке кошелька. Пожалуйста, попробуйте позже.');
          }
          break;

        case 'mint':
          try {
            // Validate mint address
            const mintAddress = ctx.message.text.trim();
            new PublicKey(mintAddress); // This will throw if invalid

            // Update state with mint address
            userStates.set(userId, {
              ...userState,
              mintAddress,
              step: 'amount',
              waitingForAmount: true
            });

            await ctx.reply(
              '✅ Адрес токена принят\n\n' +
              'Теперь введите количество SOL для покупки (например, "1.5" или "1.5 SOL"):'
            );
          } catch (error) {
            await ctx.reply('❌ Некорректный адрес токена. Пожалуйста, проверьте адрес и попробуйте снова.');
          }
          break;

        case 'amount':
          if (userState.waitingForAmount && userState.mintAddress && userState.walletNumber !== undefined) {
            const text = ctx.message.text.toLowerCase();
            const match = text.match(/^(\d+\.?\d*)\s*(?:sol|солан|solana)?$/i);
            
            if (!match) {
              await ctx.reply('❌ Пожалуйста, введите количество SOL в формате "1.5" или "1.5 SOL"');
              return;
            }

            const amount = parseFloat(match[1]);
            if (isNaN(amount) || amount <= 0) {
              await ctx.reply('❌ Пожалуйста, введите корректную сумму SOL (число больше 0)');
              return;
            }

            const message = await ctx.reply('⏳ Выполняем покупку токена...');

            try {
              // Get wallet for buying
              const wallet = await walletService.getWallet(userState.walletNumber);
              if (!wallet) {
                throw new Error(`Кошелек #${userState.walletNumber} не найден`);
              }

              // Execute token purchase
              const signature = await pumpFunService.buyTokens(
                new PublicKey(userState.mintAddress),
                amount,
                1, // Минимальное количество токенов, которое хотим получить
                wallet
              );

              let resultMessage = '✅ Токен успешно куплен!\n\n';
              resultMessage += `💰 Потрачено: ${amount} SOL\n`;
              resultMessage += `🔗 Transaction: https://solscan.io/tx/${signature}\n`;
              resultMessage += `📝 Mint Address: ${userState.mintAddress}\n`;
              resultMessage += `🏦 Кошелек: #${userState.walletNumber}\n`;
              
              await ctx.telegram.editMessageText(
                message.chat.id,
                message.message_id,
                undefined,
                resultMessage
              );

              // Clear user state
              userStates.delete(userId);

            } catch (error) {
              console.error('Error buying token:', error);
              let errorMessage = '❌ Ошибка при покупке токена:\n';
              
              if (error instanceof Error) {
                errorMessage += error.message;
                
                // Add transaction logs if available
                if ('logs' in error) {
                  console.error('Transaction logs:', (error as any).logs);
                  errorMessage += '\n\nПодробности ошибки:\n';
                  errorMessage += (error as any).logs.join('\n');
                }
              } else {
                errorMessage += 'Неизвестная ошибка';
              }
              
              await ctx.telegram.editMessageText(
                message.chat.id,
                message.message_id,
                undefined,
                errorMessage
              );
            }
          }
          break;
      }
      return;
    }

    // Handle sell_all flow
    if (userState.distributionType === 'sell_all' && userState.step === 'sell_all') {
      try {
        console.log('Starting sell_all process...');
        const mintAddress = ctx.message.text.trim();
        console.log('Mint address received:', mintAddress);
        
        try {
          const mint = new PublicKey(mintAddress);
          console.log('Mint address validated');

          const message = await ctx.reply('⏳ Начинаем продажу токенов со всех кошельков...');
          console.log('Initial message sent');
          
          // Ensure wallets are loaded
          console.log('Loading wallets from set...');
          await transactionService.loadWalletsFromSet();
          console.log('Wallets loaded successfully');
          
          console.log('Starting sellAllTokens...');
          const results = await pumpFunService.sellAllTokens(
            mint,
            async (progressText) => {
              console.log('Progress update:', progressText);
              try {
                await ctx.telegram.editMessageText(
                  message.chat.id,
                  message.message_id,
                  undefined,
                  progressText
                );
              } catch (error) {
                console.error('Error updating progress message:', error);
              }
            }
          );
          console.log('sellAllTokens completed. Results:', results);

          // Подготавливаем итоговое сообщение
          let successCount = results.filter(r => r.signature).length;
          let failCount = results.filter(r => r.error).length;
          let skipCount = results.length - successCount - failCount;

          let resultMessage = '📊 Результаты продажи токенов:\n\n';
          resultMessage += `✅ Успешно продано: ${successCount}\n`;
          resultMessage += `❌ Ошибок: ${failCount}\n`;
          resultMessage += `⏭️ Пропущено (нет токенов): ${skipCount}\n\n`;
          
          if (successCount > 0) {
            resultMessage += '🔍 Успешные транзакции:\n';
            results.forEach(result => {
              if (result.signature) {
                resultMessage += `Кошелек #${result.walletNumber}: https://solscan.io/tx/${result.signature}\n`;
              }
            });
          }

          if (failCount > 0) {
            resultMessage += '\n❌ Ошибки:\n';
            results.forEach(result => {
              if (result.error) {
                resultMessage += `Кошелек #${result.walletNumber}: ${result.error}\n`;
              }
            });
          }

          resultMessage += `\n🔗 Токен: https://pump.fun/coin/${mintAddress}`;

          await ctx.telegram.editMessageText(
            message.chat.id,
            message.message_id,
            undefined,
            resultMessage
          );

          // Очищаем состояние пользователя
          userStates.delete(userId);
        } catch (error) {
          console.error('Error validating mint address:', error);
          await ctx.reply('❌ Ошибка: Неверный адрес токена. Пожалуйста, проверьте адрес и попробуйте снова.');
        }
      } catch (error) {
        console.error('Error in sell_all step:', error);
        await ctx.reply('❌ Произошла ошибка при продаже токенов. Пожалуйста, попробуйте позже.');
        userStates.delete(userId);
      }
      return;
    }

    // Handle token creation flow
    if (userState.step) {
      console.log('Processing token creation step:', userState.step);
      
      if (!userState.tokenData) {
        userState.tokenData = createEmptyTokenData();
      }

      switch (userState.step) {
        case 'wallet':
          const walletNumber = parseInt(ctx.message.text);
          if (isNaN(walletNumber) || walletNumber < 0 || walletNumber > 100) {
            await ctx.reply('❌ Некорректный номер кошелька. Пожалуйста, введите число от 0 до 100.');
            return;
          }

          try {
            // Отправляем сообщение о загрузке
            const loadingMsg = await ctx.reply('⏳ Проверка кошелька...');
            
            // Загружаем кошельки из последнего доступного набора
            await transactionService.loadWalletsFromSet();
            
            // Проверяем существование кошелька
            const balance = await transactionService.getWalletBalance(walletNumber);
            const wallet = await walletService.getWallet(walletNumber);
            
            if (!wallet) {
              await ctx.telegram.editMessageText(
                loadingMsg.chat.id,
                loadingMsg.message_id,
                undefined,
                '❌ Ошибка: кошелек не найден'
              );
              return;
            }

            userState.tokenData.walletNumber = walletNumber;
            userState.step = 'name';

            // Формируем сообщение с информацией о кошельке
            let message = `✅ Выбран кошелек #${walletNumber}\n`;
            message += `📝 Адрес: ${wallet.publicKey.toString()}\n`;
            message += `💰 Баланс: ${balance.toFixed(4)} SOL\n\n`;

            // Добавляем предупреждение о минимальном балансе
            const minBalance = pumpFunService.MIN_SOL_BALANCE || 0.015;
            if (balance < minBalance) {
              message += `⚠️ Внимание: для создания токена необходимо минимум ${minBalance} SOL\n`;
              message += `Пожалуйста, пополните баланс кошелька на ${(minBalance - balance).toFixed(4)} SOL\n\n`;
            }

            message += 'Теперь введите название токена:';
            
            await ctx.telegram.editMessageText(
              loadingMsg.chat.id,
              loadingMsg.message_id,
              undefined,
              message
            );
          } catch (error) {
            console.error('Error checking wallet:', error);
            await ctx.reply(
              '❌ Ошибка при проверке кошелька.\n' +
              'Пожалуйста, убедитесь, что:\n' +
              '1. Вы создали кошельки через команду /create_wallets\n' +
              '2. Файл wallets.csv существует и доступен\n' +
              '3. Кошелек с указанным номером существует'
            );
            return;
          }
          break;

        case 'name':
          if (ctx.message.text.length > 32) {
            await ctx.reply('❌ Название токена слишком длинное. Максимальная длина: 32 символа');
            return;
          }
          userState.tokenData.name = ctx.message.text;
          userState.step = 'symbol';
          await ctx.reply(`✅ Название токена: ${ctx.message.text}\n\nТеперь введите символ токена (например, BTC):`);
          break;

        case 'symbol':
          if (ctx.message.text.length > 10) {
            await ctx.reply('❌ Символ токена слишком длинный. Максимальная длина: 10 символов');
            return;
          }
          // Validate symbol format
          const symbolText = ctx.message.text.toUpperCase();
          if (!/^[A-Z0-9]+$/.test(symbolText)) {
            await ctx.reply('❌ Символ токена может содержать только буквы и цифры');
            return;
          }
          userState.tokenData.symbol = symbolText;
          userState.step = 'description';
          await ctx.reply(`✅ Символ токена: ${symbolText}\n\nТеперь введите описание токена:`);
          break;

        case 'description':
          if (ctx.message.text.length > 1000) {
            await ctx.reply('❌ Описание токена слишком длинное. Максимальная длина: 1000 символов');
            return;
          }
          userState.tokenData.description = ctx.message.text;
          userState.step = 'twitter';
          await ctx.reply(`✅ Описание сохранено\n\nВведите ссылку на Twitter (или напишите "нет"):`);
          break;

        case 'twitter':
          if (ctx.message.text !== 'нет' && ctx.message.text.length > 100) {
            await ctx.reply('❌ Ссылка на Twitter слишком длинная. Максимальная длина: 100 символов');
            return;
          }
          userState.tokenData.twitter = ctx.message.text === 'нет' ? undefined : ctx.message.text;
          userState.step = 'telegram';
          await ctx.reply(`✅ Twitter ${ctx.message.text === 'нет' ? 'пропущен' : 'сохранен'}\n\nВведите ссылку на Telegram (или напишите "нет"):`);
          break;

        case 'telegram':
          if (ctx.message.text !== 'нет' && ctx.message.text.length > 100) {
            await ctx.reply('❌ Ссылка на Telegram слишком длинная. Максимальная длина: 100 символов');
            return;
          }
          userState.tokenData.telegram = ctx.message.text === 'нет' ? undefined : ctx.message.text;
          userState.step = 'website';
          await ctx.reply(`✅ Telegram ${ctx.message.text === 'нет' ? 'пропущен' : 'сохранен'}\n\nВведите ссылку на веб-сайт (или напишите "нет"):`);
          break;

        case 'website':
          if (ctx.message.text !== 'нет' && ctx.message.text.length > 100) {
            await ctx.reply('❌ Ссылка на веб-сайт слишком длинная. Максимальная длина: 100 символов');
            return;
          }
          userState.tokenData.website = ctx.message.text === 'нет' ? undefined : ctx.message.text;
          userState.step = 'picture';
          await ctx.reply(
            `✅ Веб-сайт ${ctx.message.text === 'нет' ? 'пропущен' : 'сохранен'}\n\n` +
            'Теперь отправьте изображение для токена (в формате JPG или PNG).\n\n' +
            '⚠️ Изображение необязательно. Если вы не хотите добавлять изображение, нажмите "Подтвердить" ниже.',
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '✅ Подтвердить без изображения', callback_data: 'confirm_without_image' }
                  ]
                ]
              }
            }
          );
          break;
      }
      console.log('Updated user state after token creation step:', userState);
      return;
    }

    // Handle SOL distribution amount input
    if (userState.waitingForAmount) {
      const amount = parseFloat(ctx.message.text);
      if (isNaN(amount) || amount <= 0) {
        await ctx.reply('❌ Пожалуйста, введите корректную сумму SOL (число больше 0)');
        return;
      }

      // Handle balance check separately from distribution
      if (userState.distributionType === 'checkBalance') {
        try {
          const loadingMsg = await ctx.reply('⏳ Проверяем балансы кошельков...');
          await transactionService.loadWalletsFromSet();

          let message = '📊 Результаты проверки баланса:\n\n';
          let totalFound = 0;
          let walletsWithBalance = 0;

          // Check dev wallet (0)
          const devBalance = await transactionService.getWalletBalance(0);
          if (devBalance >= amount) {
            message += `✅ Dev кошелек (#0): ${devBalance.toFixed(4)} SOL\n`;
            totalFound += devBalance;
            walletsWithBalance++;
          }

          // Check bundle wallets (1-23)
          for (let i = 1; i <= 23; i++) {
            const balance = await transactionService.getWalletBalance(i);
            if (balance >= amount) {
              message += `✅ Bundle кошелек #${i}: ${balance.toFixed(4)} SOL\n`;
              totalFound += balance;
              walletsWithBalance++;
            }
          }

          // Add summary
          message += `\n📈 Итого:\n`;
          message += `• Найдено кошельков: ${walletsWithBalance}\n`;
          message += `• Общий баланс: ${totalFound.toFixed(4)} SOL\n`;
          message += `• Минимальная сумма для проверки: ${amount} SOL`;

          await ctx.telegram.editMessageText(
            loadingMsg.chat.id,
            loadingMsg.message_id,
            undefined,
            message
          );

          // Clear user state
          userStates.delete(userId);
          return;
        } catch (error) {
          console.error('Error checking balances:', error);
          await ctx.reply('❌ Ошибка при проверке балансов. Пожалуйста, попробуйте позже.');
          return;
        }
      }

      let message = await ctx.reply('⏳ Начинаем распределение SOL...');
      const progressCallback = async (text: string) => {
        try {
          await ctx.telegram.editMessageText(
            message.chat.id,
            message.message_id,
            undefined,
            text
          );
        } catch (error) {
          console.error('Error updating progress message:', error);
        }
      };

      try {
        // Ensure wallets are loaded from the most recent set
        await transactionService.loadWalletsFromSet();
        
        let signatures: string[];
        if (userState.distributionType === 'bundle') {
          signatures = await transactionService.distributeToBundle(amount, progressCallback);
        } else if (userState.distributionType === 'marketMakers') {
          signatures = await transactionService.distributeToMarketMakers(
            amount,
            ctx.from.id.toString(), // Добавляем ID пользователя
            userState.useLookupTable ?? false,
            progressCallback
          );
        } else {
          throw new Error('Invalid distribution type');
        }

        // Clear user state
        userStates.delete(userId);

        // Send success message with transaction links
        let resultMessage = '✅ Распределение SOL завершено!\n\n';
        resultMessage += 'Транзакции:\n';
        signatures.forEach((sig, index) => {
          resultMessage += `${index + 1}. https://solscan.io/tx/${sig}\n`;
        });

        await ctx.reply(resultMessage);
      } catch (error) {
        console.error('Error distributing SOL:', error);
        await ctx.reply(
          '❌ Ошибка при распределении SOL:\n' +
          (error instanceof Error ? error.message : 'Неизвестная ошибка')
        );
      }
    }
  } catch (error) {
    console.error('Error in text message handler:', error);
    await ctx.reply('❌ Произошла ошибка. Пожалуйста, попробуйте еще раз.');
    userStates.delete(userId);
  }
});

// Check balance command
bot.command('check_balance', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  userStates.set(userId.toString(), {
    waitingForAmount: true,
    distributionType: 'checkBalance',
    tokenData: createEmptyTokenData()
  });

  await ctx.reply('Введите сумму для проверки:');
});

// Test command to verify bot is responding
bot.command('test', async (ctx) => {
  console.log('Received test command from:', ctx.from?.username);
  try {
    await ctx.reply('✅ Бот работает! Это тестовый ответ.');
  } catch (error) {
    console.error('Error in test command:', error);
  }
});

// Handle photo messages for token creation
bot.on('photo', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId) return;

  const userState = userStates.get(userId);
  if (!userState?.step || userState.step !== 'picture') {
    await ctx.reply('Пожалуйста, сначала введите название и символ токена');
    return;
  }

  if (!userState.tokenData) {
    userState.tokenData = createEmptyTokenData();
  }

  try {
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id;
    const file = await ctx.telegram.getFile(fileId);
    
    if (!file.file_path) {
      throw new Error('Не удалось получить путь к файлу');
    }

    const imageBuffer = await downloadImage(file.file_path);
    // Process image but don't enforce strict size limits
    const processedImage = await processImage(imageBuffer);
    
    userState.tokenData.picture = processedImage;
    
    await ctx.reply(
      generateTokenSummary(userState.tokenData),
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Подтвердить', callback_data: 'confirm_launch' },
              { text: '❌ Отменить', callback_data: 'cancel_launch' }
            ]
          ]
        },
        parse_mode: 'HTML'
      }
    );
  } catch (error) {
    console.error('Error processing photo:', error);
    await ctx.reply(
      '❌ Ошибка при обработке изображения:\n' +
      (error instanceof Error ? error.message : 'Неизвестная ошибка')
    );
  }
});

// Handle document messages for token creation
bot.on('document', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId) return;

  const userState = userStates.get(userId);
  if (!userState?.step || userState.step !== 'picture') {
    await ctx.reply('Пожалуйста, сначала введите название и символ токена');
    return;
  }

  if (!userState.tokenData) {
    userState.tokenData = createEmptyTokenData();
  }

  try {
    const doc = ctx.message.document;
    if (!doc.mime_type || !['image/jpeg', 'image/png'].includes(doc.mime_type)) {
      await ctx.reply('❌ Пожалуйста, отправьте изображение в формате JPG или PNG');
      return;
    }

    const file = await ctx.telegram.getFile(doc.file_id);
    if (!file.file_path) {
      throw new Error('Не удалось получить путь к файлу');
    }

    const imageBuffer = await downloadImage(file.file_path);
    // Process image but don't enforce strict size limits
    const processedImage = await processImage(imageBuffer);
    
    userState.tokenData.picture = processedImage;
    
    await ctx.reply(
      generateTokenSummary(userState.tokenData),
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Подтвердить', callback_data: 'confirm_launch' },
              { text: '❌ Отменить', callback_data: 'cancel_launch' }
            ]
          ]
        },
        parse_mode: 'HTML'
      }
    );
  } catch (error) {
    console.error('Error processing document:', error);
    await ctx.reply(
      '❌ Ошибка при обработке изображения:\n' +
      (error instanceof Error ? error.message : 'Неизвестная ошибка')
    );
  }
});

// Helper function to generate token summary
function generateTokenSummary(tokenData: TokenData): string {
  return '📝 <b>Проверьте данные токена:</b>\n\n' +
         `<b>Название:</b> ${tokenData.name || 'Не указано'}\n` +
         `<b>Символ:</b> ${tokenData.symbol || 'Не указан'}\n` +
         `<b>Описание:</b> ${tokenData.description || 'Не указано'}\n` +
         `<b>Twitter:</b> ${tokenData.twitter || 'Не указан'}\n` +
         `<b>Telegram:</b> ${tokenData.telegram || 'Не указан'}\n` +
         `<b>Веб-сайт:</b> ${tokenData.website || 'Не указан'}\n` +
         `<b>Изображение:</b> ${tokenData.picture ? '✅ Загружено' : '❌ Отсутствует'}\n\n` +
         'Подтвердите создание токена:';
}

// Helper function to download image from URL
async function downloadImage(filePath: string): Promise<Buffer> {
  const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`;
  const response = await fetch(fileUrl);
  return response.buffer();
}

// Helper function to resize and optimize image for IPFS
async function processImage(imageBuffer: Buffer): Promise<Buffer> {
  try {
    // Оптимизируем изображение для IPFS и Pump.fun
    // - Уменьшаем размер до 400x400 (более высокое разрешение для лучшего качества)
    // - Конвертируем в PNG с оптимальным сжатием
    // - Сохраняем прозрачность если она есть
    const processedImage = await sharp(imageBuffer)
      .resize(400, 400, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 0 } // Прозрачный фон
      })
      .png({
        compressionLevel: 9,
        quality: 90
      })
      .toBuffer();

    const sizeKB = processedImage.length / 1024;
    console.log(`Processed image size: ${sizeKB.toFixed(2)} KB`);
    
    // Если изображение все еще слишком большое, уменьшаем его, но сохраняем качество
    if (sizeKB > 200) {
      console.log('Image is too large, reducing size further');
      return await sharp(processedImage)
        .resize(300, 300)
        .png({
          compressionLevel: 9,
          quality: 85
        })
        .toBuffer();
    }
    
    return processedImage;
  } catch (error) {
    console.error('Error processing image:', error);
    throw new Error('Ошибка при обработке изображения. Пожалуйста, попробуйте другое изображение.');
  }
}

// Helper function to convert image buffer to base64 data URI
function imageBufferToDataUri(buffer: Buffer): string {
  const base64 = buffer.toString('base64');
  console.log('Base64 image length:', base64.length);
  return `data:image/png;base64,${base64}`;
}

// Handle launch confirmation
bot.action('confirm_launch', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId) {
    await ctx.reply('❌ Ошибка: не удалось определить пользователя');
    return;
  }

  const userState = userStates.get(userId);
  if (!userState?.tokenData) {
    await ctx.reply('❌ Ошибка: данные токена не найдены');
    return;
  }

  const { tokenData } = userState;

  // Validate required fields
  if (!tokenData.name || !tokenData.symbol || !tokenData.description || tokenData.walletNumber === undefined) {
    await ctx.reply(
      '❌ Не все обязательные поля заполнены!\n' +
      'Пожалуйста, начните процесс заново с команды /launch'
    );
    return;
  }

  try {
    const message = await ctx.reply('🚀 Запускаем создание токена...\n\nЭто может занять некоторое время. Пожалуйста, подождите.');

    try {
      console.log('Starting token creation with user data:', {
        name: tokenData.name,
        symbol: tokenData.symbol,
        description: tokenData.description,
        hasPicture: !!tokenData.picture,
        walletNumber: tokenData.walletNumber
      });
      
      // Use PumpFunService with wallet selection
      const result = await pumpFunService.createTokenWithSteps(
        {
          name: tokenData.name,
          symbol: tokenData.symbol,
          description: tokenData.description,
          image: tokenData.picture || Buffer.alloc(0),
          twitter: tokenData.twitter,
          telegram: tokenData.telegram,
          website: tokenData.website,
          walletNumber: tokenData.walletNumber
        }
      );

      console.log('Token creation successful:', result);
      
      // Save token information
      await tokenHistoryService.addToken(parseInt(userId), result);

      // Format result message
      let resultMessage = '✅ Токен успешно создан!\n\n';
      resultMessage += `Mint Address: ${result.mintAddress}\n`;
      resultMessage += `Transaction: https://solscan.io/tx/${result.signature}\n`;
      resultMessage += `Создан с кошелька #${tokenData.walletNumber}\n\n`;
      
      if (!result.signatureValid) {
        resultMessage += '⚠️ Сигнатура транзакции не валидна.\n';
      }
      
      if (result.exists) {
        resultMessage += '✅ Токен успешно создан и подтвержден в блокчейне.\n';
      } else {
        resultMessage += '⚠️ Токен создан, но пока не подтвержден в блокчейне. Это может занять некоторое время.\n';
      }
      
      resultMessage += '\nТокен создан с использованием технологии Pump.fun.\n\n';
      resultMessage += '🔄 Ожидаем подтверждения транзакции в блокчейне перед началом bundle покупки...';

      await ctx.telegram.editMessageText(
        message.chat.id,
        message.message_id,
        undefined,
        resultMessage
      );

      // Update user state for bundle buying
      userStates.set(userId, {
        distributionType: 'bundleBuy',
        bundleData: {
          retentionPercent: 0,
          totalSol: 0,
          transactions: [],
          mintAddress: result.mintAddress
        }
      });

      // Ждем 15 секунд, чтобы транзакция создания токена была подтверждена
      await new Promise(resolve => setTimeout(resolve, 15000));

      // Обновляем сообщение
      resultMessage = '✅ Токен успешно создан!\n\n';
      resultMessage += `Mint Address: ${result.mintAddress}\n`;
      resultMessage += `Transaction: https://solscan.io/tx/${result.signature}\n`;
      resultMessage += `Создан с кошелька #${tokenData.walletNumber}\n\n`;
      resultMessage += '🔄 Автоматически начинаем bundle покупку...';

      await ctx.telegram.editMessageText(
        message.chat.id,
        message.message_id,
        undefined,
        resultMessage
      );

      // Автоматически запускаем процесс bundle покупки
      await executeBundleBuy(ctx, userId, result.mintAddress, message);

    } catch (error) {
      console.error('Error in token creation:', error);
      let errorMessage = '❌ Ошибка при создании токена:\n';
      
      if (error instanceof Error) {
        errorMessage += error.message;
      } else {
        errorMessage += 'Неизвестная ошибка';
      }
      
      await ctx.reply(errorMessage);
    }
  } catch (error) {
    console.error('Error in token creation process:', error);
    await ctx.reply('❌ Произошла непредвиденная ошибка при создании токена. Пожалуйста, попробуйте позже.');
  }
});

// Handle launch cancellation
bot.action('cancel_launch', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId) {
    await ctx.reply('❌ Ошибка: не удалось определить пользователя');
    return;
  }

  userStates.delete(userId);
  await ctx.reply('❌ Создание токена отменено');
});

// Handle confirm without image button
bot.action('confirm_without_image', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId) {
    await ctx.reply('❌ Ошибка: не удалось определить пользователя');
    return;
  }

  const userState = userStates.get(userId);
  if (!userState?.tokenData) {
    await ctx.reply('❌ Ошибка: данные токена не найдены');
    return;
  }

  // Пропускаем шаг с изображением
  await ctx.reply(
    generateTokenSummary(userState.tokenData),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Подтвердить', callback_data: 'confirm_launch' },
            { text: '❌ Отменить', callback_data: 'cancel_launch' }
          ]
        ]
      },
      parse_mode: 'HTML'
    }
  );
});

// Help command
bot.command('help', async (ctx) => {
  let helpMessage = '📚 Доступные команды:\n\n';
  
  helpMessage += '🏦 Управление кошельками:\n';
  helpMessage += '/create_wallets - Создать новые кошельки\n';
  helpMessage += '/distribute_bundle - Распределить SOL на bundle кошельки\n';
  helpMessage += '/distribute_market - Распределить SOL на market making кошельки\n';
  helpMessage += '/check_balance - Проверить балансы всех кошельков\n';
  helpMessage += '/wallet_balance <номер> - Проверить баланс конкретного кошелька\n';
  helpMessage += '/dev_wallet - Информация о dev кошельке\n';
  helpMessage += '/wallet_sets - Список наборов кошельков\n';
  helpMessage += '/select_wallet_set <ID> - Выбрать набор кошельков\n\n';
  
  helpMessage += '🪙 Управление токенами:\n';
  helpMessage += '/launch - Создать новый токен\n';
  helpMessage += '/mytokens - Список созданных токенов\n';
  helpMessage += '/buytoken - Купить существующий токен на Pump.fun\n\n';
  
  helpMessage += '❓ Для получения подробной информации о каждой команде, используйте /help <команда>\n';
  helpMessage += 'Например: /help buytoken';
  
  await ctx.reply(helpMessage);
});

// Handle bundle confirmation
bot.action('confirm_bundle', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId) {
    await ctx.reply('❌ Ошибка: не удалось определить пользователя');
    return;
  }

  const userState = userStates.get(userId);
  if (!userState?.bundleData) {
    await ctx.reply('❌ Ошибка: данные для bundle покупки не найдены');
    return;
  }

  const { mintAddress } = userState.bundleData;
  if (!mintAddress) {
    await ctx.reply('❌ Ошибка: неполные данные для bundle покупки');
    return;
  }

  // Проверяем валидность адреса токена
  try {
    new PublicKey(mintAddress);
  } catch (error) {
    await ctx.reply(`❌ Ошибка: недействительный адрес токена (${mintAddress})`);
    return;
  }

  const loadingMsg = await ctx.reply('⏳ Выполняем bundle покупки...');
  
  // Используем общую функцию для выполнения bundle покупки
  await executeBundleBuy(ctx, userId, mintAddress, loadingMsg);
});

bot.action('cancel_bundle', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (userId) {
    userStates.delete(userId);
  }
  await ctx.reply('❌ Bundle покупка отменена');
});

// Add middleware to ensure dev wallet is initialized before handling commands
bot.use(async (ctx, next) => {
  try {
    console.log('Checking dev wallet in middleware...');
    const devWallet = walletService.getDevWallet();
    if (!devWallet) {
      console.log('Dev wallet not found in middleware, attempting to initialize...');
      // If no dev wallet is set, create a new one
      const keypair = Keypair.generate();
      await walletService.setDevWallet(keypair);
      console.log('Created new dev wallet:', keypair.publicKey.toString());
    }
    console.log('Dev wallet check completed, proceeding with command...');
    return next();
  } catch (error) {
    console.error('Error in wallet middleware:', error);
    if (ctx.message) {
      await ctx.reply('❌ Ошибка инициализации кошелька. Пожалуйста, попробуйте позже.');
    }
    // Still proceed with next middleware even if there's an error
    return next();
  }
});

// Select wallet set command
bot.command('select_wallet_set', async (ctx) => {
  try {
    const setId = ctx.message.text.split(' ')[1];
    if (!setId) {
      ctx.reply('❌ Пожалуйста, укажите ID набора кошельков. Например: /select_wallet_set 14a');
      return;
    }

    const set = walletSetService.getWalletSet(setId);
    if (!set) {
      ctx.reply(`❌ Набор кошельков с ID "${setId}" не найден. Используйте /wallet_sets для просмотра доступных наборов.`);
      return;
    }

    await walletService.setActiveWalletSet(setId);
    const date = set.createdAt.toLocaleDateString('ru-RU');
    ctx.reply(`✅ Выбран набор кошельков ${setId} (создан ${date})`);
  } catch (error) {
    console.error('Error in select_wallet_set command:', error);
    ctx.reply('❌ Ошибка при выборе набора кошельков. Пожалуйста, попробуйте позже.');
  }
});

// Modify wallet_sets command to show active set
bot.command('wallet_sets', async (ctx) => {
  try {
    const sets = walletSetService.getWalletSets();
    
    if (sets.length === 0) {
      ctx.reply('❌ Нет доступных наборов кошельков. Создайте новый набор с помощью команды /create_wallets');
      return;
    }

    const activeSetId = walletService.getActiveWalletSetId();
    let message = '📝 Доступные наборы кошельков:\n\n';
    
    sets.forEach(set => {
      const date = set.createdAt.toLocaleDateString('ru-RU');
      const isActive = set.id === activeSetId ? ' ✅' : '';
      message += `🔹 Набор ${set.id} (создан ${date})${isActive}\n`;
    });

    message += '\nДля выбора набора используйте команду /select_wallet_set <ID>';
    ctx.reply(message);
  } catch (error) {
    console.error('Error in wallet_sets command:', error);
    ctx.reply('❌ Ошибка при получении списка наборов. Пожалуйста, попробуйте позже.');
  }
});

// Wallet balance command
bot.command('wallet_balance', async (ctx) => {
  try {
    const walletNumber = parseInt(ctx.message.text.split(' ')[1]);
    
    if (isNaN(walletNumber) || walletNumber < 0 || walletNumber > 100) {
      ctx.reply(
        '❌ Пожалуйста, укажите корректный номер кошелька (0-100).\n\n' +
        'Например: /wallet_balance 24\n\n' +
        '0 - dev кошелек\n' +
        '1-23 - bundle кошельки\n' +
        '24 - bundle payer кошелек\n' +
        '25 - market making payer кошелек\n' +
        '26-100 - market making кошельки'
      );
      return;
    }

    const loadingMsg = await ctx.reply('⏳ Проверяем баланс кошелька...');
    
    const activeSetId = walletService.getActiveWalletSetId();
    const wallet = await walletService.getWallet(walletNumber);
    
    if (!wallet) {
      await ctx.telegram.editMessageText(
        loadingMsg.chat.id,
        loadingMsg.message_id,
        undefined,
        '❌ Кошелек не найден'
      );
      return;
    }

    const balance = await transactionService.getWalletBalance(walletNumber);
    let walletType = '';
    
    if (walletNumber === 0) walletType = 'Dev кошелек';
    else if (walletNumber >= 1 && walletNumber <= 23) walletType = 'Bundle кошелек';
    else if (walletNumber === 24) walletType = 'Bundle payer кошелек';
    else if (walletNumber === 25) walletType = 'Market making payer кошелек';
    else walletType = 'Market making кошелек';

    let message = `💰 Информация о кошельке #${walletNumber}\n\n`;
    message += `📝 Тип: ${walletType}\n`;
    message += `💳 Адрес: ${wallet.publicKey.toString()}\n`;
    message += `💰 Баланс: ${balance.toFixed(4)} SOL\n`;
    
    if (activeSetId) {
      message += `📚 Набор кошельков: ${activeSetId}\n`;
    }
    
    message += '\n🔍 Посмотреть на Solscan:\n';
    message += `https://solscan.io/account/${wallet.publicKey.toString()}`;

    await ctx.telegram.editMessageText(
      loadingMsg.chat.id,
      loadingMsg.message_id,
      undefined,
      message
    );
  } catch (error) {
    console.error('Error in wallet_balance command:', error);
    ctx.reply('❌ Ошибка при проверке баланса кошелька. Пожалуйста, попробуйте позже.');
  }
});

// Handle wallet menu buttons
// ... existing code ...

bot.hears(new RegExp(WALLET_MENU_BUTTONS.SELECT_SET.replace('🎯', '.*').trim()), async (ctx) => {
  console.log('Received select wallet set button click');
  
  try {
    const sets = walletSetService.getWalletSets();
    
    if (sets.length === 0) {
      ctx.reply('❌ Нет доступных наборов кошельков. Создайте новый набор с помощью кнопки "Create Wallets"');
      return;
    }

    const activeSetId = walletService.getActiveWalletSetId();
    const buttons = sets.map(set => {
      const date = set.createdAt.toLocaleDateString('ru-RU');
      const isActive = set.id === activeSetId ? ' ✅' : '';
      return [{
        text: `${set.id} (${date})${isActive}`,
        callback_data: `select_set_${set.id}`
      }];
    });

    await ctx.reply(
      '🎯 Выберите набор кошельков:\n\n' +
      'Текущий активный набор отмечен галочкой ✅',
      {
        reply_markup: {
          inline_keyboard: [
            ...buttons,
            [{
              text: '❌ Отмена',
              callback_data: 'cancel_select_set'
            }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Error in select set button:', error);
    ctx.reply('❌ Ошибка при получении списка наборов. Пожалуйста, попробуйте позже.');
  }
});

// Handle set selection
bot.action(/^select_set_(.+)$/, async (ctx) => {
  console.log('Received select set callback');
  
  try {
    const setId = ctx.match[1];
    const set = walletSetService.getWalletSet(setId);
    
    if (!set) {
      await ctx.reply(`❌ Набор кошельков с ID "${setId}" не найден.`);
      return;
    }

    await walletService.setActiveWalletSet(setId);
    const date = set.createdAt.toLocaleDateString('ru-RU');
    
    await ctx.editMessageText(
      `✅ Выбран набор кошельков ${setId} (создан ${date})\n\n` +
      'Все операции теперь будут использовать кошельки из этого набора.'
    );
  } catch (error) {
    console.error('Error selecting wallet set:', error);
    await ctx.reply('❌ Ошибка при выборе набора кошельков. Пожалуйста, попробуйте позже.');
  }
});

// Handle selection cancellation
bot.action('cancel_select_set', async (ctx) => {
  await ctx.editMessageText('❌ Выбор набора кошельков отменен');
});

// Handle market making confirmation
bot.action('confirm_market', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId) {
    await ctx.reply('❌ Ошибка: не удалось определить пользователя');
    return;
  }

  const userState = userStates.get(userId);
  if (!userState?.mintAddress) {
    await ctx.reply('❌ Ошибка: адрес токена не найден');
    return;
  }

  const loadingMsg = await ctx.reply('⏳ Выполняем market making покупки...');
  let successCount = 0;
  let failCount = 0;
  let totalBoughtSol = 0;

  try {
    // Market making wallets: 26-100
    for (let i = 26; i <= 100; i++) {
      try {
        const wallet = await walletService.getWallet(i);
        if (!wallet) {
          console.log(`Wallet #${i} not found, skipping`);
          continue;
        }

        // Получаем актуальный баланс кошелька
        const currentBalance = await transactionService.getWalletBalance(i);
        
        // Максимально простой расчет: оставляем только 0.001 SOL на комиссию
        const reserveForFee = 0.001;
        const amountToSpend = Math.max(0, currentBalance - reserveForFee);

        console.log(`Market making wallet #${i} balance calculation:`, {
          currentBalance,
          reserveForFee,
          amountToSpend,
          willBeLeft: currentBalance - amountToSpend
        });

        if (amountToSpend > 0) {
          const signature = await pumpFunService.buyTokens(
            new PublicKey(userState.mintAddress),
            amountToSpend,
            0, // minTokenAmount рассчитывается внутри buyTokens
            wallet
          );

          successCount++;
          totalBoughtSol += amountToSpend;

          // Update progress
          await ctx.telegram.editMessageText(
            loadingMsg.chat.id,
            loadingMsg.message_id,
            undefined,
            `⏳ Выполнено ${successCount} транзакций...\n` +
            `💰 Всего потрачено: ${totalBoughtSol.toFixed(4)} SOL`
          );

          // Добавляем небольшую задержку между транзакциями
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error(`Error in transaction for wallet #${i}:`, error);
        failCount++;
      }
    }

    // Final summary
    let summary = '📊 Результаты market making покупок:\n\n';
    summary += `✅ Успешно: ${successCount}\n`;
    summary += `❌ Неудачно: ${failCount}\n`;
    summary += `💰 Всего потрачено: ${totalBoughtSol.toFixed(4)} SOL\n\n`;
    summary += `🔗 Токен: https://pump.fun/coin/${userState.mintAddress}`;

    await ctx.telegram.editMessageText(
      loadingMsg.chat.id,
      loadingMsg.message_id,
      undefined,
      summary
    );

    // Clear user state
    userStates.delete(userId);
  } catch (error) {
    console.error('Error in market making execution:', error);
    await ctx.reply('❌ Ошибка при выполнении market making покупок');
  }
});

// Новая функция для выполнения bundle покупки
async function executeBundleBuy(ctx: any, userId: string, mintAddress: string, loadingMsg: any) {
  let successCount = 0;
  let failCount = 0;
  let totalBoughtSol = 0;
  let lastError = '';

  try {
    // Проверяем существование токена и его bonding curve
    try {
      const connection = new Connection(process.env.RPC_URL || 'https://api.devnet.solana.com');
      const mintPubkey = new PublicKey(mintAddress);
      
      // Проверяем существование токена с повторными попытками
      let mintInfo = null;
      let attempts = 0;
      const maxAttempts = 5;
      
      while (!mintInfo && attempts < maxAttempts) {
        attempts++;
        try {
          mintInfo = await connection.getAccountInfo(mintPubkey);
          if (!mintInfo) {
            await ctx.telegram.editMessageText(
              loadingMsg.chat.id,
              loadingMsg.message_id,
              undefined,
              `⏳ Ожидаем подтверждения токена в блокчейне (попытка ${attempts}/${maxAttempts})...`
            );
            // Ждем 5 секунд перед следующей попыткой
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        } catch (e) {
          console.error(`Attempt ${attempts} failed:`, e);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      
      if (!mintInfo) {
        await ctx.telegram.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          undefined,
          `⚠️ Токен с адресом ${mintAddress} не найден после ${maxAttempts} попыток. Возможно, транзакция еще не подтверждена. Попробуйте выполнить bundle покупку позже.`
        );
        return;
      }
      
      // Проверяем существование bonding curve с повторными попытками
      const [bondingCurvePublicKey] = await PublicKey.findProgramAddress(
        [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
        PUMP_FUN_PROGRAM_ID
      );
      
      let bondingCurveInfo = null;
      attempts = 0;
      
      while (!bondingCurveInfo && attempts < maxAttempts) {
        attempts++;
        try {
          bondingCurveInfo = await connection.getAccountInfo(bondingCurvePublicKey);
          if (!bondingCurveInfo) {
            await ctx.telegram.editMessageText(
              loadingMsg.chat.id,
              loadingMsg.message_id,
              undefined,
              `⏳ Ожидаем создания bonding curve (попытка ${attempts}/${maxAttempts})...`
            );
            // Ждем 5 секунд перед следующей попыткой
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        } catch (e) {
          console.error(`Bonding curve attempt ${attempts} failed:`, e);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      
      if (!bondingCurveInfo) {
        await ctx.telegram.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          undefined,
          `❌ Ошибка: bonding curve для токена ${mintAddress} не найдена после ${maxAttempts} попыток.\n` +
          `Возможно, это не токен Pump.fun или он был создан с использованием другой программы.`
        );
        return;
      }
      
      // Если мы дошли до этого места, значит токен и bonding curve существуют
      await ctx.telegram.editMessageText(
        loadingMsg.chat.id,
        loadingMsg.message_id,
        undefined,
        `✅ Токен и bonding curve найдены! Начинаем bundle покупку...`
      );
      
    } catch (error) {
      console.error('Error checking token:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await ctx.telegram.editMessageText(
        loadingMsg.chat.id,
        loadingMsg.message_id,
        undefined,
        `❌ Ошибка при проверке токена: ${errorMessage}`
      );
      return;
    }

    // Используем только кошельки 0-23 для bundle
    const walletNumbers = Array.from({ length: 24 }, (_, i) => i);
    
    for (const walletNumber of walletNumbers) {
      try {
        const wallet = await walletService.getWallet(walletNumber);
        if (!wallet) {
          console.log(`Кошелек #${walletNumber} не найден, пропускаем`);
          continue;
        }

        // Получаем актуальный баланс кошелька
        const currentBalance = await transactionService.getWalletBalance(walletNumber);
        
        // Оставляем только 0.001 SOL на комиссию
        const reserveForFee = 0.001;
        const amountToSpend = Math.max(0, currentBalance - reserveForFee);

        console.log(`Bundle wallet #${walletNumber} balance calculation:`, {
          currentBalance,
          reserveForFee,
          amountToSpend,
          willBeLeft: currentBalance - amountToSpend
        });

        if (amountToSpend > 0) {
          const signature = await pumpFunService.buyTokens(
            new PublicKey(mintAddress),
            amountToSpend,
            0, // minTokenAmount рассчитывается внутри buyTokens
            wallet
          );

          successCount++;
          totalBoughtSol += amountToSpend;

          // Update progress
          await ctx.telegram.editMessageText(
            loadingMsg.chat.id,
            loadingMsg.message_id,
            undefined,
            `⏳ Выполнено ${successCount} транзакций...\n` +
            `💰 Всего потрачено: ${totalBoughtSol.toFixed(4)} SOL`
          );

          // Добавляем небольшую задержку между транзакциями
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error(`Error in transaction for wallet #${walletNumber}:`, error);
        lastError = error instanceof Error ? error.message : 'Unknown error';
        failCount++;
      }
    }

    // Финальное сообщение
    let finalMessage = `✅ Bundle покупка завершена!\n\n`;
    finalMessage += `📊 Статистика:\n`;
    finalMessage += `✓ Успешных транзакций: ${successCount}\n`;
    finalMessage += `✗ Неудачных транзакций: ${failCount}\n`;
    finalMessage += `💰 Всего потрачено: ${totalBoughtSol.toFixed(4)} SOL\n\n`;
    
    if (lastError) {
      finalMessage += `⚠️ Последняя ошибка: ${lastError}\n\n`;
    }
    
    finalMessage += `🔗 Токен: ${mintAddress}\n`;
    finalMessage += `🔍 Просмотреть на Solscan: https://solscan.io/token/${mintAddress}`;

    await ctx.telegram.editMessageText(
      loadingMsg.chat.id,
      loadingMsg.message_id,
      undefined,
      finalMessage
    );

  } catch (error) {
    console.error('Error in bundle buy execution:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    await ctx.telegram.editMessageText(
      loadingMsg.chat.id,
      loadingMsg.message_id,
      undefined,
      `❌ Ошибка при выполнении bundle покупки: ${errorMessage}`
    );
  }
}