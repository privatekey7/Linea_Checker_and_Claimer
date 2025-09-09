/**
 * Типы для работы с базой данных кошельков
 */

export interface WalletData {
  address: string
  allocation: string
  is_eligible: number // 0 или 1
  has_claimed: number // 0 или 1
  token_balance: string | null
  last_balance_check: number | null
  claim_end: number
  created_at: number
  order_index: number
}

export interface DatabaseStats {
  total: number
  eligible: number
  claimed: number
  totalAllocation: string
}

export interface WalletEligibilityData {
  isEligible: boolean
  allocation: string
  hasClaimed: boolean
  claimEnd: Date
  isExpired: boolean
}
