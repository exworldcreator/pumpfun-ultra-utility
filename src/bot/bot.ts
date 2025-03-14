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
import { Keypair, LAMPORTS_PER_SOL, SendTransactionError } from '@solana/web3.js';
import { message } from 'telegraf/filters';
import sharp from 'sharp';
import { PublicKey } from '@solana/web3.js';

dotenv.config();

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN must be provided in environment variables');
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const walletService = new WalletService();
const transactionService = new TransactionService(walletService);
const walletSetService = new WalletSetService();
const pumpFunService = new PumpFunService(walletService);
const tokenHistoryService = new TokenHistoryService();

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
  totalSol: number;
  transactions: BundleTransaction[];
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

// Create dev wallet
async function createDevWallet() {
  console.log('Creating new dev wallet...');
  const keypair = Keypair.generate();
  const wallet = {
    publicKey: keypair.publicKey.toString(),
    privateKey: Buffer.from(keypair.secretKey).toString('base64')
  };
  
  // Save wallet to file
  fs.writeFileSync(path.join(__dirname, '../../dev-wallet.json'), JSON.stringify(wallet, null, 2));
  
  // Set in wallet service
  walletService.setDevWallet(keypair);
  
  return wallet;
}

// Initialize dev wallet
async function initDevWallet() {
  const walletPath = path.join(__dirname, '../../dev-wallet.json');
  
  try {
    if (fs.existsSync(walletPath)) {
      console.log('Loading existing dev wallet...');
      const wallet = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
      const secretKey = Buffer.from(wallet.privateKey, 'base64');
      const keypair = Keypair.fromSecretKey(secretKey);
      walletService.setDevWallet(keypair);
      return wallet;
    }
  } catch (error) {
    console.error('Error loading dev wallet:', error);
  }
  
  return createDevWallet();
}

// Add debug middleware to log all updates
bot.use((ctx, next) => {
  console.log('Received update:', JSON.stringify(ctx.update, null, 2));
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
    [WALLET_MENU_BUTTONS.WALLET_SETS],
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
    // 1. Initialize dev wallet
    const wallet = await initDevWallet();
    const balance = await transactionService.getDevWalletBalance(wallet.publicKey);
    
    // 2. Send welcome message
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
    const wallet = await initDevWallet();
    const balance = await transactionService.getDevWalletBalance(wallet.publicKey);
    
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('Yes, create with Lookup Tables', 'create_with_lut'),
        Markup.button.callback('No, just create wallets', 'create_without_lut')
      ]
    ]);
    
    let message = 'Do you want to create Lookup Tables along with the wallets?\n\n' +
                  'Lookup Tables allow for more efficient transactions but require SOL for creation.';
    
    if (balance < 0.03) {
      message += '\n\n⚠️ Warning: Dev wallet has insufficient SOL for creating Lookup Tables.\n' +
                 `Current balance: ${balance.toFixed(4)} SOL\n` +
                 `Dev wallet address: ${wallet.publicKey}\n` +
                 'Please fund this wallet with at least 0.03 SOL before creating Lookup Tables.';
    } else {
      message += `\n\nDev wallet balance: ${balance.toFixed(4)} SOL ✅`;
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
    const wallet = await initDevWallet();
    await transactionService.loadWalletsFromSet();
    const balance = await transactionService.getWalletBalance(24);
    
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
    console.error('Error in distribute_bundle button:', error);
    ctx.reply('❌ Ошибка при проверке баланса. Пожалуйста, попробуйте позже.');
  }
});

bot.hears(WALLET_MENU_BUTTONS.DISTRIBUTE_MARKET, async (ctx) => {
  console.log('Received distribute market button click');
  
  try {
    const wallet = await initDevWallet();
    await transactionService.loadWalletsFromSet();
    const balance = await transactionService.getWalletBalance(25);
    
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
    console.error('Error in distribute_market button:', error);
    ctx.reply('❌ Ошибка при проверке баланса. Пожалуйста, попробуйте позже.');
  }
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
    const wallet = await initDevWallet();
    const balance = await transactionService.getDevWalletBalance(wallet.publicKey);
    
    let message = '🔑 Dev Wallet Information:\n\n' +
                  `📝 Public Key: ${wallet.publicKey}\n` +
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

    let message = '📝 Доступные наборы кошельков:\n\n';
    sets.forEach(set => {
      const date = set.createdAt.toLocaleDateString('ru-RU');
      message += `🔹 Набор ${set.id} (создан ${date})\n`;
    });

    ctx.reply(message);
  } catch (error) {
    console.error('Error in wallet_sets button:', error);
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
              { text: '📦 Bundle покупка', callback_data: 'buy_bundle' }
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
    const wallet = await initDevWallet();
    const balance = await transactionService.getDevWalletBalance(wallet.publicKey);
    
    let message = '🔑 Dev Wallet Information:\n\n' +
                  `📝 Public Key: ${wallet.publicKey}\n` +
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
    const wallet = await initDevWallet();
    const balance = await transactionService.getDevWalletBalance(wallet.publicKey);
    
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('Yes, create with Lookup Tables', 'create_with_lut'),
        Markup.button.callback('No, just create wallets', 'create_without_lut')
      ]
    ]);
    
    let message = 'Do you want to create Lookup Tables along with the wallets?\n\n' +
                  'Lookup Tables allow for more efficient transactions but require SOL for creation.';
    
    if (balance < 0.03) {
      message += '\n\n⚠️ Warning: Dev wallet has insufficient SOL for creating Lookup Tables.\n' +
                 `Current balance: ${balance.toFixed(4)} SOL\n` +
                 `Dev wallet address: ${wallet.publicKey}\n` +
                 'Please fund this wallet with at least 0.03 SOL before creating Lookup Tables.';
    } else {
      message += `\n\nDev wallet balance: ${balance.toFixed(4)} SOL ✅`;
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
    const wallet = await initDevWallet();
    
    if (createWithLUT) {
      const balance = await transactionService.getDevWalletBalance(wallet.publicKey);
      
      if (balance < 0.03) {
        ctx.reply(`⚠️ Warning: Dev wallet has insufficient SOL for creating Lookup Tables.\n` +
                  `Current balance: ${balance.toFixed(4)} SOL\n` +
                  `Dev wallet address: ${wallet.publicKey}\n\n` +
                  `Proceeding with wallet creation, but Lookup Tables will not be created.\n` +
                  `Please fund the dev wallet and try again later.`);
        
        const result = await walletService.generateWallets(false);
        await handleWalletCreationResult(ctx, result, true);
        return;
      }
    }
    
    ctx.reply(`Starting wallet generation process${createWithLUT ? ' with Lookup Tables' : ''}...\n` +
              'This may take a few minutes...');
    
    const result = await walletService.generateWallets(createWithLUT);
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
                 `📝 Адрес dev кошелька: ${(await initDevWallet()).publicKey}\n` +
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

    let message = '📝 Доступные наборы кошельков:\n\n';
    sets.forEach(set => {
      const date = set.createdAt.toLocaleDateString('ru-RU');
      message += `🔹 Набор ${set.id} (создан ${date})\n`;
    });

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
    const wallet = await initDevWallet();
    
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
  console.log('Received distribute_market command from:', ctx.from?.username);
  
  try {
    const wallet = await initDevWallet();
    
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
    ctx.reply('❌ Ошибка при проверке баланса. Пожалуйста, попробуйте позже.');
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
              { text: '📦 Bundle покупка', callback_data: 'buy_bundle' }
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
            userState.step = 'retention';

            await ctx.reply(
              'Введите процент баланса, который нужно оставить на каждом кошельке (например, 5):'
            );
          } catch (error) {
            await ctx.reply('❌ Некорректный адрес токена. Пожалуйста, проверьте адрес и попробуйте снова.');
          }
          break;

        case 'retention':
          const percent = parseFloat(ctx.message.text);
          if (isNaN(percent) || percent < 0 || percent > 100) {
            await ctx.reply('❌ Пожалуйста, введите корректный процент от 0 до 100');
            return;
          }

          try {
            // Calculate purchases for all bundle wallets
            const transactions: BundleTransaction[] = [];
            let totalSol = 0;
            const maxPoolSize = 85; // Maximum pool size in SOL

            // First, calculate dev wallet purchase (wallet 0)
            const devWallet = await walletService.getWallet(0);
            if (devWallet) {
              const devBalance = await transactionService.getWalletBalance(0);
              const devAmount = devBalance * (1 - percent / 100);
              if (devAmount > 0) {
                transactions.push({ walletNumber: 0, amount: devAmount });
                totalSol += devAmount;
              }
            }

            // Then calculate bundle wallets (1-23)
            for (let i = 1; i <= 23; i++) {
              if (totalSol >= maxPoolSize) break;

              const wallet = await walletService.getWallet(i);
              if (wallet) {
                const balance = await transactionService.getWalletBalance(i);
                const amount = balance * (1 - percent / 100);
                if (amount > 0) {
                  const remainingSpace = maxPoolSize - totalSol;
                  const actualAmount = Math.min(amount, remainingSpace);
                  transactions.push({ walletNumber: i, amount: actualAmount });
                  totalSol += actualAmount;
                  if (totalSol >= maxPoolSize) break;
                }
              }
            }

            userState.bundleData = {
              ...userState.bundleData!,
              retentionPercent: percent,
              totalSol,
              transactions
            };

            // Show summary and confirmation
            let summary = '📝 Проверьте данные для bundle покупки:\n\n';
            summary += `🔹 Токен: ${userState.bundleData.mintAddress}\n`;
            summary += `🔹 Процент остатка: ${percent}%\n`;
            summary += `🔹 Всего SOL: ${totalSol.toFixed(4)}\n\n`;
            summary += 'Транзакции:\n';
            transactions.forEach(tx => {
              summary += `Кошелек #${tx.walletNumber}: ${tx.amount.toFixed(4)} SOL\n`;
            });
            
            await ctx.reply(
              summary,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '✅ Подтвердить', callback_data: 'confirm_bundle' },
                      { text: '❌ Отменить', callback_data: 'cancel_bundle' }
                    ]
                  ]
                }
              }
            );
          } catch (error) {
            console.error('Error calculating bundle purchases:', error);
            await ctx.reply('❌ Ошибка при расчете bundle покупок. Пожалуйста, попробуйте позже.');
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

          resultMessage += `\n🔗 Токен: https://pump.fun/token/${mintAddress}`;

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
    // Оптимизируем изображение для IPFS
    // - Уменьшаем размер до 256x256
    // - Конвертируем в PNG с высоким сжатием
    // - Ограничиваем размер файла
    const processedImage = await sharp(imageBuffer)
      .resize(256, 256, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      })
      .png({
        compressionLevel: 9,
        quality: 80,
        palette: true // Используем палитру для уменьшения размера
      })
      .toBuffer();

    const sizeKB = processedImage.length / 1024;
    console.log(`Processed image size: ${sizeKB.toFixed(2)} KB`);
    
    // Если изображение все еще слишком большое, уменьшаем его еще сильнее
    if (sizeKB > 100) {
      console.log('Image is too large, reducing quality further');
      return await sharp(processedImage)
        .resize(128, 128)
        .png({
          compressionLevel: 9,
          quality: 60,
          palette: true,
          colors: 64 // Ограничиваем количество цветов
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
      resultMessage += 'Введите процент баланса, который нужно оставить на каждом кошельке (например, 5):';

      await ctx.telegram.editMessageText(
        message.chat.id,
        message.message_id,
        undefined,
        resultMessage
      );

      // Update user state for bundle buying
      userStates.set(userId, {
        distributionType: 'bundleBuy',
        step: 'retention',
        bundleData: {
          retentionPercent: 0,
          totalSol: 0,
          transactions: [],
          mintAddress: result.mintAddress
        }
      });

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
  helpMessage += '/check_balance - Проверить баланс кошелька\n';
  helpMessage += '/dev_wallet - Информация о dev кошельке\n';
  helpMessage += '/wallet_sets - Список наборов кошельков\n\n';
  
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

  const { mintAddress, transactions } = userState.bundleData;
  if (!mintAddress || !transactions.length) {
    await ctx.reply('❌ Ошибка: неполные данные для bundle покупки');
    return;
  }

  const loadingMsg = await ctx.reply('⏳ Выполняем bundle покупки...');
  let successCount = 0;
  let failCount = 0;

  try {
    for (const tx of transactions) {
      try {
        const wallet = await walletService.getWallet(tx.walletNumber);
        if (!wallet) {
          throw new Error(`Кошелек #${tx.walletNumber} не найден`);
        }

        const signature = await pumpFunService.buyTokens(
          new PublicKey(mintAddress),
          tx.amount,
          1, // минимальное количество токенов
          wallet
        );

        tx.signature = signature;
        successCount++;

        // Update progress
        await ctx.telegram.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          undefined,
          `⏳ Выполнено ${successCount} из ${transactions.length} транзакций...`
        );
      } catch (error) {
        console.error(`Error in transaction for wallet #${tx.walletNumber}:`, error);
        failCount++;
      }
    }

    // Final summary
    let summary = '📊 Результаты bundle покупки:\n\n';
    summary += `✅ Успешно: ${successCount}\n`;
    summary += `❌ Неудачно: ${failCount}\n\n`;
    summary += `🔗 Токен: https://pump.fun/token/${mintAddress}\n\n`;
    summary += 'Транзакции:\n';
    transactions.forEach(tx => {
      if (tx.signature) {
        summary += `Кошелек #${tx.walletNumber}: https://solscan.io/tx/${tx.signature}\n`;
      }
    });

    await ctx.telegram.editMessageText(
      loadingMsg.chat.id,
      loadingMsg.message_id,
      undefined,
      summary
    );

    // Clear user state
    userStates.delete(userId);
  } catch (error) {
    console.error('Error in bundle execution:', error);
    await ctx.reply('❌ Ошибка при выполнении bundle покупок');
  }
});

bot.action('cancel_bundle', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (userId) {
    userStates.delete(userId);
  }
  await ctx.reply('❌ Bundle покупка отменена');
});

// Launch bot
bot.launch().then(async () => {
  console.log('Bot started successfully!');
  console.log('Bot username:', bot.botInfo?.username);
  
  // Initialize dev wallet on startup
  try {
    const wallet = await initDevWallet();
    console.log('Dev wallet initialized:', wallet.publicKey);
    
    // Initialize transaction service with dev wallet
    const balance = await transactionService.getDevWalletBalance(wallet.publicKey);
    console.log('Dev wallet balance:', balance.toFixed(4), 'SOL');

    // Start accepting commands
    console.log('Bot ready to accept commands...');
  } catch (error) {
    console.error('Failed to initialize dev wallet:', error);
    throw new Error('Bot initialization failed: Dev wallet could not be initialized');
  }
}).catch((error) => {
  console.error('Error starting bot:', error);
  process.exit(1); // Exit if initialization fails
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Add middleware to ensure dev wallet is initialized before handling commands
bot.use(async (ctx, next) => {
  try {
    console.log('Checking dev wallet in middleware...');
    const devWallet = walletService.getDevWallet();
    if (!devWallet) {
      console.log('Dev wallet not found in middleware, attempting to initialize...');
      await initDevWallet();
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