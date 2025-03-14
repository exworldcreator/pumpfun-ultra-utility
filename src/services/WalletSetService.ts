import * as fs from 'fs';
import * as path from 'path';
import { WalletData } from './WalletService';

interface WalletSet {
  id: string;  // e.g. "13a", "13b"
  createdAt: Date;
  wallets: WalletData[];
}

export class WalletSetService {
  private dbPath: string;
  private walletSets: Map<string, WalletSet>;

  constructor() {
    this.dbPath = path.join(__dirname, '../../db');
    this.walletSets = new Map();
    this.initializeDB();
  }

  private initializeDB() {
    if (!fs.existsSync(this.dbPath)) {
      fs.mkdirSync(this.dbPath, { recursive: true });
    }

    // Load existing wallet sets
    const setsPath = path.join(this.dbPath, 'wallet-sets.json');
    if (fs.existsSync(setsPath)) {
      const data = JSON.parse(fs.readFileSync(setsPath, 'utf8'));
      Object.entries(data).forEach(([id, set]) => {
        this.walletSets.set(id, {
          ...set as WalletSet,
          createdAt: new Date((set as WalletSet).createdAt)
        });
      });
    }
  }

  private saveDB() {
    const data = Object.fromEntries(this.walletSets.entries());
    fs.writeFileSync(
      path.join(this.dbPath, 'wallet-sets.json'),
      JSON.stringify(data, null, 2)
    );
  }

  // Generate new wallet set ID
  private generateSetId(): string {
    const now = new Date();
    const day = now.getDate().toString().padStart(2, '0');
    
    // Find the next available letter
    const todaysSets = Array.from(this.walletSets.keys())
      .filter(id => id.startsWith(day))
      .map(id => id[id.length - 1]);
    
    if (todaysSets.length === 0) {
      return `${day}a`;
    }
    
    const lastLetter = todaysSets.sort().pop()!;
    return `${day}${String.fromCharCode(lastLetter.charCodeAt(0) + 1)}`;
  }

  // Create new wallet set
  async createWalletSet(wallets: WalletData[]): Promise<string> {
    const id = this.generateSetId();
    
    this.walletSets.set(id, {
      id,
      createdAt: new Date(),
      wallets
    });

    this.saveDB();
    return id;
  }

  // Get all wallet sets
  getWalletSets(): WalletSet[] {
    return Array.from(this.walletSets.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  // Get specific wallet set
  getWalletSet(id: string): WalletSet | undefined {
    return this.walletSets.get(id);
  }

  // Delete wallet set
  deleteWalletSet(id: string): boolean {
    const deleted = this.walletSets.delete(id);
    if (deleted) {
      this.saveDB();
    }
    return deleted;
  }
} 