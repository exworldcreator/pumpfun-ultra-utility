# PumpFun Bot

Telegram bot for managing wallets and tokens on Pump.fun platform.

## Features

- Wallet Management
  - Create wallets (with/without Lookup Tables)
  - Distribute SOL to bundle wallets
  - Distribute SOL to market making wallets

## Prerequisites

- Node.js (v16 or higher)
- PostgreSQL
- Telegram Bot Token (from @BotFather)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd pf-token-launch
```

2. Install dependencies:
```bash
npm install
```

3. Create environment file:
```bash
cp .env.example .env
```

4. Edit `.env` file with your configuration:
- Add your Telegram Bot Token
- Configure PostgreSQL connection details

5. Build the project:
```bash
npm run build
```

## Usage

1. Start the bot:
```bash
npm start
```

2. In Telegram, find your bot and start it with `/start`

3. Available commands:
   - `/create_wallets` - Generate 101 Solana wallets with option to create Lookup Tables
   - `/check_balance` - Check the balance of payer wallets
   - `/distribute_bundle` - Distribute SOL from wallet #24 to bundle wallets (1-23)
   - `/distribute_market` - Distribute SOL from wallet #25 to market making wallets (26-100)
   - `/lut_info` - Get information about created Lookup Tables

### Wallet Creation with Lookup Tables

When you use the `/create_wallets` command, you'll be asked if you want to create Lookup Tables along with the wallets:

1. **With Lookup Tables**: Creates wallets and sets up Lookup Tables for efficient transactions
2. **Without Lookup Tables**: Creates only the wallets without Lookup Tables

The dev wallet (index 0) is used to pay for the creation of Lookup Tables, so it needs to have some SOL if you choose to create with Lookup Tables.

### Wallet Distribution

The bot supports two types of SOL distribution:

1. **Bundle Distribution**: Distributes SOL from wallet #24 (bundle payer) to wallets #1-23 (bundle wallets)
2. **Market Making Distribution**: Distributes SOL from wallet #25 (market making payer) to wallets #26-100 (market making wallets)

When distributing SOL, the bot will:
- Ask whether to use Address Lookup Tables for faster transactions
- Ask how much SOL to distribute
- Distribute the specified amount with a 20% variance between wallets
- Provide transaction details for each transfer

### Address Lookup Tables (LUT)

The bot supports Solana's Address Lookup Tables for more efficient transactions:

- **What are LUTs?** Address Lookup Tables allow you to reference multiple addresses in a transaction without including the full address each time, reducing transaction size and fees.
- **Benefits**: Enables batch processing of transactions, making distribution to multiple wallets faster and more cost-effective.
- **Creation**: Integrated with wallet creation for a seamless experience.
- **Usage**: When distributing SOL, you'll be asked if you want to use lookup tables.

## Security Notes

- Keep your private keys secure and never share them
- The CSV file with wallet information is deleted from the server immediately after being sent
- Store the wallet information in a secure location
- Private keys are stored in base58 format for better compatibility with Solana tools and wallets

## Database Structure

### Wallets Table

The `wallets` table stores information about all Solana wallets managed by the bot:

```sql
CREATE TABLE wallets (
    wallet_number INTEGER PRIMARY KEY,    -- Номер кошелька в наборе
    public_key VARCHAR(255) NOT NULL,     -- Публичный ключ кошелька
    private_key TEXT NOT NULL,            -- Приватный ключ в формате base58
    wallet_type VARCHAR(50) NOT NULL,     -- Тип кошелька (dev/bundle/bundle_payer/market_maker/market_maker_payer)
    set_id VARCHAR(255) NOT NULL,         -- Идентификатор набора кошельков
    created_at TIMESTAMP WITH TIME ZONE,  -- Время создания записи
    updated_at TIMESTAMP WITH TIME ZONE   -- Время последнего обновления
);
```

#### Indexes
- `idx_wallets_public_key` - для быстрого поиска по публичному ключу
- `idx_wallets_set_id` - для быстрого поиска по идентификатору набора
- `idx_wallets_public_key_set_id` - уникальный индекс для комбинации публичного ключа и идентификатора набора

#### Wallet Types
- `dev` (0) - Кошелек разработчика, используется для создания LUT
- `bundle` (1-23) - Кошельки для пакетных операций
- `bundle_payer` (24) - Кошелек для оплаты пакетных операций
- `market_maker_payer` (25) - Кошелек для оплаты операций маркет-мейкинга
- `market_maker` (26-100) - Кошельки для маркет-мейкинга

## License

MIT