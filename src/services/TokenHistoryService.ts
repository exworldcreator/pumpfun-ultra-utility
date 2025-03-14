import * as fs from 'fs';
import { promisify } from 'util';
import { TokenCreationResult } from './PumpFunService';

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const mkdir = promisify(fs.mkdir);
const exists = promisify(fs.exists);

interface UserTokenHistory {
    userId: number;
    tokens: TokenCreationResult[];
}

export class TokenHistoryService {
    private readonly dataDir: string;
    private userTokens: Map<number, TokenCreationResult[]>;
    private tokens: Map<number, TokenCreationResult[]> = new Map();
    
    constructor(dataDir: string = './data/tokens') {
        this.dataDir = dataDir;
        this.userTokens = new Map();
        this.init();
    }
    
    private async init(): Promise<void> {
        try {
            // Создаем директорию для хранения данных, если она не существует
            if (!await exists(this.dataDir)) {
                await mkdir(this.dataDir, { recursive: true });
                console.log(`Created token history directory: ${this.dataDir}`);
            }
        } catch (error) {
            console.error('Error initializing TokenHistoryService:', error);
        }
    }
    
    private getUserFilePath(userId: number): string {
        return `${this.dataDir}/${userId}.json`;
    }
    
    public async addToken(userId: number, token: TokenCreationResult): Promise<void> {
        if (!this.tokens.has(userId)) {
            this.tokens.set(userId, []);
        }
        this.tokens.get(userId)?.push(token);
    }
    
    public async getUserTokens(userId: number): Promise<TokenCreationResult[]> {
        return this.tokens.get(userId) || [];
    }
    
    private async saveUserTokens(userId: number, tokens: TokenCreationResult[]): Promise<void> {
        try {
            const filePath = this.getUserFilePath(userId);
            const userHistory: UserTokenHistory = {
                userId,
                tokens
            };
            
            await writeFile(filePath, JSON.stringify(userHistory, null, 2), 'utf-8');
        } catch (error) {
            console.error(`Error saving tokens for user ${userId}:`, error);
        }
    }
    
    public async updateTokenStatus(userId: number, mintAddress: string, updatedStatus: Partial<TokenCreationResult>): Promise<void> {
        try {
            const userTokens = await this.getUserTokens(userId);
            
            // Находим токен по адресу минта
            const tokenIndex = userTokens.findIndex(token => token.mintAddress === mintAddress);
            
            if (tokenIndex === -1) {
                console.warn(`Token ${mintAddress} not found for user ${userId}`);
                return;
            }
            
            // Обновляем статус токена
            userTokens[tokenIndex] = {
                ...userTokens[tokenIndex],
                ...updatedStatus
            };
            
            // Сохраняем обновленные данные
            await this.saveUserTokens(userId, userTokens);
            
            console.log(`Updated status for token ${mintAddress} for user ${userId}`);
        } catch (error) {
            console.error(`Error updating token status for user ${userId}:`, error);
        }
    }
} 