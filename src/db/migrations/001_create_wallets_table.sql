-- Создание таблицы wallets
CREATE TABLE IF NOT EXISTS wallets (
    wallet_number INTEGER PRIMARY KEY,
    public_key VARCHAR(255) NOT NULL,
    private_key TEXT NOT NULL,
    wallet_type VARCHAR(50) NOT NULL,
    set_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Создание индекса для ускорения поиска по public_key
CREATE INDEX IF NOT EXISTS idx_wallets_public_key ON wallets(public_key);

-- Создание индекса для ускорения поиска по set_id
CREATE INDEX IF NOT EXISTS idx_wallets_set_id ON wallets(set_id);

-- Создание уникального индекса для комбинации public_key и set_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_public_key_set_id ON wallets(public_key, set_id);

-- Добавление комментариев к таблице
COMMENT ON TABLE wallets IS 'Таблица для хранения информации о кошельках';
COMMENT ON COLUMN wallets.wallet_number IS 'Номер кошелька в наборе';
COMMENT ON COLUMN wallets.public_key IS 'Публичный ключ кошелька';
COMMENT ON COLUMN wallets.private_key IS 'Зашифрованный приватный ключ кошелька';
COMMENT ON COLUMN wallets.wallet_type IS 'Тип кошелька';
COMMENT ON COLUMN wallets.set_id IS 'Идентификатор набора кошельков'; 