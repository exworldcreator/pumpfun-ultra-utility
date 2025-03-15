import * as fs from 'fs';
import * as path from 'path';

// Типы логов
export enum LogLevel {
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  DEBUG = 'DEBUG',
  TRANSACTION = 'TRANSACTION',
  USER_ACTION = 'USER_ACTION'
}

// Интерфейс для структурированного лога
export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
  userId?: string;
  username?: string;
  actionType?: string;
  details?: any;
}

// Функция для логирования в файл
export function logToFile(entry: LogEntry): void {
  const logDir = path.join(process.cwd(), 'logs');
  
  // Создаем директорию для логов, если она не существует
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  
  // Определяем файл лога в зависимости от типа
  let logFile: string;
  
  switch (entry.level) {
    case LogLevel.ERROR:
      logFile = path.join(logDir, 'errors.log');
      break;
    case LogLevel.TRANSACTION:
      logFile = path.join(logDir, 'transactions.log');
      break;
    case LogLevel.USER_ACTION:
      logFile = path.join(logDir, 'user_actions.log');
      break;
    default:
      logFile = path.join(logDir, 'app.log');
  }
  
  // Форматируем детали
  let detailsStr = '';
  if (entry.details) {
    try {
      if (typeof entry.details === 'object') {
        detailsStr = JSON.stringify(entry.details, null, 2);
      } else {
        detailsStr = String(entry.details);
      }
    } catch (e) {
      detailsStr = 'Failed to stringify details';
    }
  }
  
  // Форматируем запись лога
  const logEntry = `[${entry.timestamp.toISOString()}] [${entry.level}] ${entry.message}\n` +
                  `User: ${entry.userId || 'Unknown'} (${entry.username || 'Unknown'})\n` +
                  `Action: ${entry.actionType || 'Unknown'}\n` +
                  (detailsStr ? `Details: ${detailsStr}\n` : '') +
                  `-------------------------------------------\n`;
  
  // Записываем в файл
  fs.appendFileSync(logFile, logEntry);
  
  // Дублируем в консоль для отладки
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[${entry.level}] ${entry.message}`);
  }
}

// Функция для логирования информации
export function logInfo(message: string, userId?: string, username?: string, actionType?: string, details?: any): void {
  logToFile({
    level: LogLevel.INFO,
    message,
    timestamp: new Date(),
    userId,
    username,
    actionType,
    details
  });
}

// Функция для логирования предупреждений
export function logWarning(message: string, userId?: string, username?: string, actionType?: string, details?: any): void {
  logToFile({
    level: LogLevel.WARNING,
    message,
    timestamp: new Date(),
    userId,
    username,
    actionType,
    details
  });
}

// Функция для логирования ошибок
export function logError(message: string, userId?: string, username?: string, actionType?: string, details?: any): void {
  logToFile({
    level: LogLevel.ERROR,
    message,
    timestamp: new Date(),
    userId,
    username,
    actionType,
    details
  });
}

// Функция для логирования отладочной информации
export function logDebug(message: string, userId?: string, username?: string, actionType?: string, details?: any): void {
  if (process.env.DEBUG === 'true') {
    logToFile({
      level: LogLevel.DEBUG,
      message,
      timestamp: new Date(),
      userId,
      username,
      actionType,
      details
    });
  }
}

// Функция для логирования транзакций
export function logTransaction(message: string, userId?: string, username?: string, details?: any): void {
  logToFile({
    level: LogLevel.TRANSACTION,
    message,
    timestamp: new Date(),
    userId,
    username,
    actionType: 'Transaction',
    details
  });
}

// Функция для логирования действий пользователя
export function logUserAction(message: string, userId?: string, username?: string, actionType?: string, details?: any): void {
  logToFile({
    level: LogLevel.USER_ACTION,
    message,
    timestamp: new Date(),
    userId,
    username,
    actionType,
    details
  });
} 