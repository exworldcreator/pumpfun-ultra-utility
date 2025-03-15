import { Context } from 'telegraf';
import * as fs from 'fs';
import * as path from 'path';

// Типы ошибок
export enum ErrorType {
  RPC_ERROR = 'RPC_ERROR',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  TRANSACTION_ERROR = 'TRANSACTION_ERROR',
  WALLET_ERROR = 'WALLET_ERROR',
  TOKEN_ERROR = 'TOKEN_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

// Интерфейс для структурированной ошибки
export interface StructuredError {
  type: ErrorType;
  message: string;
  details?: string;
  timestamp: Date;
  userId?: string;
  actionType?: string;
}

// Функция для определения типа ошибки
export function determineErrorType(error: any): ErrorType {
  const errorMessage = error instanceof Error ? error.message : String(error);
  
  if (errorMessage.includes('429') || errorMessage.includes('Too Many Requests') || 
      errorMessage.includes('rate limit') || errorMessage.includes('timeout')) {
    return ErrorType.RPC_ERROR;
  }
  
  if (errorMessage.includes('insufficient') || errorMessage.includes('Insufficient') || 
      errorMessage.includes('balance') || errorMessage.includes('0.001')) {
    return ErrorType.INSUFFICIENT_BALANCE;
  }
  
  if (errorMessage.includes('transaction') || errorMessage.includes('Transaction') || 
      errorMessage.includes('signature') || errorMessage.includes('blockhash')) {
    return ErrorType.TRANSACTION_ERROR;
  }
  
  if (errorMessage.includes('wallet') || errorMessage.includes('Wallet') || 
      errorMessage.includes('keypair') || errorMessage.includes('private key')) {
    return ErrorType.WALLET_ERROR;
  }
  
  if (errorMessage.includes('token') || errorMessage.includes('Token') || 
      errorMessage.includes('mint') || errorMessage.includes('bonding curve')) {
    return ErrorType.TOKEN_ERROR;
  }
  
  if (errorMessage.includes('network') || errorMessage.includes('connection') || 
      errorMessage.includes('fetch') || errorMessage.includes('request')) {
    return ErrorType.NETWORK_ERROR;
  }
  
  return ErrorType.UNKNOWN_ERROR;
}

// Функция для получения пользовательского сообщения об ошибке
export function getUserFriendlyErrorMessage(error: any): string {
  const errorType = determineErrorType(error);
  const errorMessage = error instanceof Error ? error.message : String(error);
  
  switch (errorType) {
    case ErrorType.RPC_ERROR:
      return '❌ Ошибка RPC: Проблема с подключением к блокчейну. Возможно, сервер перегружен. Попробуйте повторить операцию позже.';
    
    case ErrorType.INSUFFICIENT_BALANCE:
      return '❌ Недостаточный баланс: На кошельке недостаточно SOL для выполнения операции. Пополните баланс и попробуйте снова.';
    
    case ErrorType.TRANSACTION_ERROR:
      return '❌ Ошибка транзакции: Не удалось выполнить транзакцию. Проверьте параметры и попробуйте снова.';
    
    case ErrorType.WALLET_ERROR:
      return '❌ Ошибка кошелька: Проблема с доступом к кошельку или его созданием. Проверьте настройки и попробуйте снова.';
    
    case ErrorType.TOKEN_ERROR:
      return '❌ Ошибка токена: Проблема с токеном или его параметрами. Проверьте адрес токена и его доступность.';
    
    case ErrorType.NETWORK_ERROR:
      return '❌ Ошибка сети: Проблема с подключением к сети. Проверьте ваше интернет-соединение и попробуйте снова.';
    
    default:
      return `❌ Неизвестная ошибка: ${errorMessage}`;
  }
}

// Функция для логирования ошибок в файл
export function logError(error: StructuredError): void {
  const logDir = path.join(process.cwd(), 'logs');
  const logFile = path.join(logDir, 'errors.log');
  
  // Создаем директорию для логов, если она не существует
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  
  const logEntry = `[${error.timestamp.toISOString()}] [${error.type}] ${error.message}\n` +
                  `User: ${error.userId || 'Unknown'}\n` +
                  `Action: ${error.actionType || 'Unknown'}\n` +
                  `Details: ${error.details || 'No details'}\n` +
                  `-------------------------------------------\n`;
  
  fs.appendFileSync(logFile, logEntry);
}

// Функция для обработки ошибок и отправки сообщения пользователю
export async function handleError(ctx: Context, error: any, actionType?: string): Promise<void> {
  const userId = ctx.from?.id.toString();
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorType = determineErrorType(error);
  
  // Создаем структурированную ошибку
  const structuredError: StructuredError = {
    type: errorType,
    message: errorMessage,
    timestamp: new Date(),
    userId,
    actionType
  };
  
  // Логируем ошибку
  logError(structuredError);
  
  // Получаем пользовательское сообщение
  const userMessage = getUserFriendlyErrorMessage(error);
  
  // Отправляем сообщение пользователю
  try {
    await ctx.reply(userMessage);
    
    // Для серьезных ошибок добавляем техническую информацию
    if (errorType === ErrorType.UNKNOWN_ERROR) {
      await ctx.reply(
        '📋 Техническая информация для поддержки:\n' +
        `Тип: ${errorType}\n` +
        `Время: ${structuredError.timestamp.toISOString()}\n` +
        `Действие: ${actionType || 'Неизвестно'}\n` +
        `Ошибка: ${errorMessage.substring(0, 200)}`
      );
    }
  } catch (replyError) {
    console.error('Failed to send error message to user:', replyError);
  }
} 