import Database from 'better-sqlite3'
import * as fs from 'fs'

/**
 * Инициализация базы данных SQLite
 */
export function initializeDatabase (): Database.Database {
  // Удаляем временные файлы WAL если они существуют
  cleanupTempFiles()

  const db = new Database('database.db')

  // Принудительно отключаем WAL режим и используем DELETE режим
  db.pragma('journal_mode = DELETE')

  // Дополнительные настройки для отключения WAL
  db.pragma('wal_autocheckpoint = 0')
  db.pragma('wal_checkpoint = TRUNCATE')

  // Проверяем текущий режим журналирования
  db.pragma('journal_mode', { simple: true })

  // Создаем таблицу если она не существует
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      address TEXT PRIMARY KEY,
      allocation TEXT NOT NULL,
      is_eligible INTEGER NOT NULL,
      has_claimed INTEGER NOT NULL,
      token_balance TEXT,
      last_balance_check INTEGER,
      claim_end INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      order_index INTEGER NOT NULL DEFAULT 0
    )
  `)

  // Добавляем колонку order_index если она не существует (для существующих БД)
  try {
    db.exec('ALTER TABLE wallets ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0')
  } catch {
    // Колонка уже существует, игнорируем ошибку
  }

  // Создаем индексы для быстрого поиска
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_is_eligible ON wallets(is_eligible)
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_has_claimed ON wallets(has_claimed)
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_last_balance_check ON wallets(last_balance_check)
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_order_index ON wallets(order_index)
  `)

  console.log('✅ База данных инициализирована')
  return db
}

/**
 * Закрытие соединения с базой данных
 */
export function closeDatabase (db: Database.Database): void {
  db.close()
  console.log('✅ Соединение с базой данных закрыто')
}

/**
 * Очистка временных файлов SQLite
 */
export function cleanupTempFiles (): void {
  const tempFiles = ['database.db-wal', 'database.db-shm']

  for (const file of tempFiles) {
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file)
        console.log(`🗑️ Удален временный файл: ${file}`)
      } catch (error) {
        console.log(`⚠️ Не удалось удалить ${file}:`, error instanceof Error ? error.message : 'Неизвестная ошибка')
      }
    }
  }
}
