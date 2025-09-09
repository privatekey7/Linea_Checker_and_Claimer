import Database from 'better-sqlite3'
import { WalletData, DatabaseStats, WalletEligibilityData } from './types.js'

export class WalletDatabase {
  private db: Database.Database

  constructor (db: Database.Database) {
    this.db = db
  }

  /**
   * Получение данных кошелька из БД
   */
  async getWalletData (address: string): Promise<WalletData | null> {
    const stmt = this.db.prepare('SELECT * FROM wallets WHERE address = ?')
    const result = stmt.get(address) as WalletData | undefined
    return result || null
  }

  /**
   * Сохранение/обновление данных кошелька в БД
   */
  async saveWalletData (address: string, data: WalletEligibilityData, orderIndex: number = 0): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO wallets 
      (address, allocation, is_eligible, has_claimed, token_balance, last_balance_check, claim_end, created_at, order_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const now = Date.now()
    stmt.run(
      address,
      data.allocation,
      data.isEligible ? 1 : 0,
      data.hasClaimed ? 1 : 0,
      null, // token_balance будет обновлен отдельно
      null, // last_balance_check будет обновлен отдельно
      data.claimEnd.getTime(),
      now,
      orderIndex
    )
  }

  /**
   * Обновление только динамических данных (баланс и статус клейма)
   */
  async updateDynamicData (address: string, hasClaimed: boolean, balance: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE wallets 
      SET has_claimed = ?, token_balance = ?, last_balance_check = ?
      WHERE address = ?
    `)

    stmt.run(
      hasClaimed ? 1 : 0,
      balance,
      Date.now(),
      address
    )
  }

  /**
   * Получение всех кошельков
   */
  async getAllWallets (): Promise<WalletData[]> {
    const stmt = this.db.prepare('SELECT * FROM wallets ORDER BY order_index ASC, created_at ASC')
    return stmt.all() as WalletData[]
  }

  /**
   * Получение только eligible кошельков
   */
  async getEligibleWallets (): Promise<WalletData[]> {
    const stmt = this.db.prepare('SELECT * FROM wallets WHERE is_eligible = 1 ORDER BY order_index ASC, created_at ASC')
    return stmt.all() as WalletData[]
  }

  /**
   * Получение кошельков, которые уже получили токены
   */
  async getClaimedWallets (): Promise<WalletData[]> {
    const stmt = this.db.prepare('SELECT * FROM wallets WHERE has_claimed = 1 ORDER BY order_index ASC, created_at ASC')
    return stmt.all() as WalletData[]
  }

  /**
   * Получение кошельков, которые еще не получили токены
   */
  async getUnclaimedWallets (): Promise<WalletData[]> {
    const stmt = this.db.prepare('SELECT * FROM wallets WHERE is_eligible = 1 AND has_claimed = 0 ORDER BY order_index ASC, created_at ASC')
    return stmt.all() as WalletData[]
  }

  /**
   * Получение статистики по базе данных
   */
  async getStats (): Promise<DatabaseStats> {
    const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM wallets')
    const eligibleStmt = this.db.prepare('SELECT COUNT(*) as count FROM wallets WHERE is_eligible = 1')
    const claimedStmt = this.db.prepare('SELECT COUNT(*) as count FROM wallets WHERE has_claimed = 1')
    const allocationStmt = this.db.prepare('SELECT SUM(CAST(allocation AS REAL)) as total FROM wallets WHERE is_eligible = 1')

    const total = (totalStmt.get() as { count: number }).count
    const eligible = (eligibleStmt.get() as { count: number }).count
    const claimed = (claimedStmt.get() as { count: number }).count
    const totalAllocation = (allocationStmt.get() as { total: number | null }).total || 0

    return {
      total,
      eligible,
      claimed,
      totalAllocation: totalAllocation.toString()
    }
  }

  /**
   * Очистка всех данных
   */
  async clearAll (): Promise<void> {
    this.db.prepare('DELETE FROM wallets').run()
    console.log('🗑️ Все данные из базы данных удалены')
  }

  /**
   * Удаление конкретного кошелька
   */
  async removeWallet (address: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM wallets WHERE address = ?')
    const result = stmt.run(address)

    if (result.changes > 0) {
      console.log(`🗑️ Кошелек ${address} удален из базы данных`)
    } else {
      console.log(`❌ Кошелек ${address} не найден в базе данных`)
    }
  }

  /**
   * Проверка нужно ли обновлять динамические данные
   * (баланс и статус клейма проверяем каждые 5 минут)
   */
  shouldUpdateDynamicData (cachedData: WalletData): boolean {
    if (!cachedData.last_balance_check) return true

    const timeDiff = Date.now() - cachedData.last_balance_check
    const fiveMinutes = 5 * 60 * 1000

    return timeDiff > fiveMinutes
  }

  /**
   * Конвертация данных из БД в формат WalletEligibilityData
   */
  convertDbToEligibility (dbData: WalletData, _currentBalance: string, currentClaimStatus: boolean): WalletEligibilityData {
    return {
      isEligible: dbData.is_eligible === 1,
      allocation: dbData.allocation,
      hasClaimed: currentClaimStatus,
      claimEnd: new Date(dbData.claim_end),
      isExpired: Date.now() > dbData.claim_end
    }
  }
}
