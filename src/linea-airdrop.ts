import { createPublicClient, createWalletClient, http, formatUnits, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { lineaAirdropAbi, CONTRACT_ADDRESS, TOKEN_ADDRESS, LINEA_RPC_URL } from './linea-airdrop-abi.js'
import prompts from 'prompts'
import { KeyEncryption } from './key-encryption.js'
import { setupEncoding } from './encoding-setup.js'
import { initializeDatabase, closeDatabase } from './database/database-init.js'
import { WalletDatabase } from './database/wallet-database.js'
import { WalletEligibilityData } from './database/types.js'
import Database from 'better-sqlite3'

// Настройка кодировки для Windows
setupEncoding()

// Определение Linea chain
const linea = {
  id: 59144,
  name: 'Linea',
  network: 'linea',
  nativeCurrency: {
    decimals: 18,
    name: 'Ethereum',
    symbol: 'ETH'
  },
  rpcUrls: {
    default: {
      http: [LINEA_RPC_URL]
    },
    public: {
      http: [LINEA_RPC_URL]
    }
  },
  blockExplorers: {
    default: {
      name: 'LineaScan',
      url: 'https://lineascan.build'
    }
  }
} as const

export class LineaAirdropChecker {
  private publicClient: ReturnType<typeof createPublicClient>
  private walletClient: ReturnType<typeof createWalletClient> | null = null
  private database: WalletDatabase | null = null

  constructor () {
    this.publicClient = createPublicClient({
      chain: linea,
      transport: http()
    })
  }

  /**
   * Инициализация базы данных
   */
  async initialize (): Promise<void> {
    const db = initializeDatabase()
    this.database = new WalletDatabase(db)
  }

  /**
   * Закрытие соединения с базой данных
   */
  async close (): Promise<void> {
    if (this.database) {
      // Получаем ссылку на базу данных для закрытия
      const db = (this.database as unknown as { db: Database.Database }).db
      if (db) {
        closeDatabase(db)
      }
      this.database = null
    }
  }

  /**
   * Получение экземпляра базы данных
   */
  getDatabase (): WalletDatabase | null {
    return this.database
  }

  // Подключение кошелька
  async connectWallet (privateKey: string): Promise<void> {
    try {
      const account = privateKeyToAccount(privateKey as `0x${string}`)
      this.walletClient = createWalletClient({
        account,
        chain: linea,
        transport: http()
      })
      console.log(`✅ Кошелек подключен: ${account.address}`)
    } catch (error) {
      throw new Error(`Ошибка подключения кошелька: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
    }
  }

  // Получение адреса подключенного кошелька
  getWalletAddress (): string {
    if (!this.walletClient) {
      throw new Error('Кошелек не подключен')
    }
    return this.walletClient.account?.address || ''
  }

  // Проверка права на airdrop с использованием БД
  async checkEligibility (address: string, orderIndex: number = 0): Promise<WalletEligibilityData> {
    try {
      // 1. Проверяем локальную БД
      if (this.database) {
        const cached = await this.database.getWalletData(address)

        if (cached) {
          // Проверяем нужно ли обновлять динамические данные
          if (this.database.shouldUpdateDynamicData(cached)) {
            // Проверяем только динамические данные (баланс и статус клейма)
            const currentBalance = await this.getTokenBalance(address)
            const currentClaimStatus = await this.checkClaimStatus(address)

            // Обновляем только если что-то изменилось
            if (currentBalance !== cached.token_balance || currentClaimStatus !== (cached.has_claimed === 1)) {
              await this.database.updateDynamicData(address, currentClaimStatus, currentBalance)
            }

            return this.database.convertDbToEligibility(cached, currentBalance, currentClaimStatus)
          } else {
            // Используем кэшированные данные без обновления
            const currentBalance = cached.token_balance || '0'
            const currentClaimStatus = cached.has_claimed === 1
            return this.database.convertDbToEligibility(cached, currentBalance, currentClaimStatus)
          }
        }
      }

      // 2. Если данных нет в БД - делаем полную проверку через RPC
      const freshData = await this.fetchFromRPC(address)

      // 3. Сохраняем в БД
      if (this.database) {
        await this.database.saveWalletData(address, freshData, orderIndex)
      }

      return freshData
    } catch (error) {
      throw new Error(`Ошибка проверки права на airdrop: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
    }
  }

  /**
   * Получение данных через RPC (без БД)
   */
  private async fetchFromRPC (address: string): Promise<WalletEligibilityData> {
    // Проверяем аллокацию
    const allocation = await this.publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: lineaAirdropAbi,
      functionName: 'calculateAllocation',
      args: [address as `0x${string}`]
    })

    // Проверяем, был ли уже клейм
    const hasClaimed = await this.publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: lineaAirdropAbi,
      functionName: 'hasClaimed',
      args: [address as `0x${string}`]
    })

    // Получаем время окончания клейма
    const claimEnd = await this.publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: lineaAirdropAbi,
      functionName: 'CLAIM_END'
    })

    const claimEndDate = new Date(Number(claimEnd) * 1000)
    const isExpired = Date.now() > claimEndDate.getTime()
    const isEligible = allocation > 0n && !hasClaimed && !isExpired

    const allocationFormatted = formatUnits(allocation, 18)

    return {
      isEligible,
      allocation: allocationFormatted,
      hasClaimed,
      claimEnd: claimEndDate,
      isExpired
    }
  }

  /**
   * Проверка статуса клейма (отдельный метод для обновления)
   */
  private async checkClaimStatus (address: string): Promise<boolean> {
    const hasClaimed = await this.publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: lineaAirdropAbi,
      functionName: 'hasClaimed',
      args: [address as `0x${string}`]
    })
    return hasClaimed
  }

  // Получение токенов (клейм)
  async claimTokens (): Promise<string> {
    if (!this.walletClient) {
      throw new Error('Кошелек не подключен')
    }

    try {
      console.log('🚀 Начинаем клейм токенов...')

      // Проверяем право на клейм перед отправкой транзакции
      const address = this.getWalletAddress()
      const eligibility = await this.checkEligibility(address, 0)

      if (!eligibility.isEligible) {
        if (eligibility.hasClaimed) {
          throw new Error('❌ Токены уже были получены')
        }
        if (eligibility.isExpired) {
          throw new Error('❌ Время для получения токенов истекло')
        }
        if (eligibility.allocation === '0') {
          throw new Error('❌ Нет права на получение токенов')
        }
      }

      console.log(`💰 Размер аллокации: ${eligibility.allocation} токенов`)

      // Отправляем транзакцию клейма
      if (!this.walletClient.account) {
        throw new Error('Аккаунт не найден в кошельке')
      }

      const data = encodeFunctionData({
        abi: lineaAirdropAbi,
        functionName: 'claim'
      })

      const hash = await this.walletClient.sendTransaction({
        to: CONTRACT_ADDRESS,
        data,
        account: this.walletClient.account,
        chain: linea
      })

      console.log(`⏳ Транзакция отправлена: ${hash}`)
      console.log('⏳ Ожидаем подтверждения...')

      // Ждем подтверждения транзакции
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: hash as `0x${string}`
      })

      if (receipt.status === 'success') {
        console.log('✅ Токены успешно получены!')
        console.log(`📄 Хеш транзакции: ${hash}`)
        console.log(`🔗 Ссылка: https://lineascan.build/tx/${hash}`)
        return hash
      } else {
        throw new Error('❌ Транзакция не удалась')
      }
    } catch (error) {
      throw new Error(`Ошибка при получении токенов: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
    }
  }

  // Получение баланса токенов
  async getTokenBalance (address: string): Promise<string> {
    try {
      const balance = await this.publicClient.readContract({
        address: TOKEN_ADDRESS,
        abi: [
          {
            inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
            name: 'balanceOf',
            outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
            stateMutability: 'view',
            type: 'function'
          }
        ],
        functionName: 'balanceOf',
        args: [address as `0x${string}`]
      })

      return formatUnits(balance, 18)
    } catch (error) {
      throw new Error(`Ошибка получения баланса: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
    }
  }
}

// Основная функция
export async function main (): Promise<void> {
  try {
    console.log('🎯 Linea Airdrop Checker & Claimer')
    console.log('=====================================\n')

    // Проверяем и предлагаем шифрование ключей
    const shouldExit = await KeyEncryption.checkAndOfferEncryption()
    if (shouldExit) {
      return
    }

    const checker = new LineaAirdropChecker()

    // Выбор режима работы
    const { mode } = await prompts({
      type: 'select',
      name: 'mode',
      message: 'Выберите режим работы:',
      choices: [
        { title: '🔍 Только проверка (без подключения кошелька)', value: 'check' },
        { title: '🚀 Проверка + клейм (требует приватный ключ)', value: 'claim' }
      ]
    })

    if (!mode) {
      console.log('❌ Режим не выбран')
      return
    }

    if (mode === 'check') {
      // Режим только проверки
      const { address } = await prompts({
        type: 'text',
        name: 'address',
        message: 'Введите адрес для проверки:',
        validate: (value: string) => {
          if (!value) return 'Адрес не может быть пустым'
          if (!/^0x[a-fA-F0-9]{40}$/.test(value)) return 'Неверный формат адреса'
          return true
        }
      })

      if (!address) {
        console.log('❌ Адрес не введен')
        return
      }

      const eligibility = await checker.checkEligibility(address, 0)

      console.log('\n📊 Результаты проверки:')
      console.log('========================')
      console.log(`📍 Адрес: ${address}`)
      console.log(`💰 Аллокация: ${eligibility.allocation} токенов`)
      console.log(`✅ Право на получение: ${eligibility.isEligible ? 'Да' : 'Нет'}`)
      console.log(`🎯 Уже получено: ${eligibility.hasClaimed ? 'Да' : 'Нет'}`)
      console.log(`⏰ Окончание клейма: ${eligibility.claimEnd.toLocaleString('ru-RU', { timeZone: 'UTC' })} UTC`)
      console.log(`⏳ Время истекло: ${eligibility.isExpired ? 'Да' : 'Нет'}`)

      if (eligibility.allocation !== '0') {
        const balance = await checker.getTokenBalance(address)
        console.log(`💎 Текущий баланс токенов: ${balance}`)
      }

    } else if (mode === 'claim') {
      // Режим клейма
      let privateKeys: string[] = []

      if (KeyEncryption.hasEncryptedKeys()) {
        // Используем зашифрованные ключи
        privateKeys = await KeyEncryption.promptPasswordWithRetry()
      } else {
        // Запрашиваем приватный ключ
        const { privateKey } = await prompts({
          type: 'invisible',
          name: 'privateKey',
          message: 'Введите приватный ключ:',
          validate: (value: string) => {
            if (!value) return 'Приватный ключ не может быть пустым'
            if (!/^0x[a-fA-F0-9]{64}$/.test(value)) return 'Неверный формат приватного ключа'
            return true
          }
        })

        if (!privateKey) {
          console.log('❌ Приватный ключ не введен')
          return
        }

        privateKeys = [privateKey]
      }

      // Обрабатываем каждый ключ
      for (let i = 0; i < privateKeys.length; i++) {
        const privateKey = privateKeys[i]

        if (!privateKey) {
          console.log(`❌ Пропускаем пустой ключ ${i + 1}`)
          continue
        }

        try {
          console.log(`\n🔄 Обрабатываем кошелек ${i + 1}/${privateKeys.length}`)

          await checker.connectWallet(privateKey)
          const address = checker.getWalletAddress()

          // Проверяем право на клейм
          const eligibility = await checker.checkEligibility(address, 0)

          console.log(`\n📊 Результаты для ${address}:`)
          console.log(`💰 Аллокация: ${eligibility.allocation} токенов`)
          console.log(`✅ Право на получение: ${eligibility.isEligible ? 'Да' : 'Нет'}`)
          console.log(`🎯 Уже получено: ${eligibility.hasClaimed ? 'Да' : 'Нет'}`)

          if (eligibility.isEligible) {
            const { shouldClaim } = await prompts({
              type: 'confirm',
              name: 'shouldClaim',
              message: `Получить ${eligibility.allocation} токенов?`,
              initial: true
            })

            if (shouldClaim) {
              await checker.claimTokens()
            }
          } else {
            console.log('⏭️  Пропускаем - нет права на получение или уже получено')
          }

        } catch (error) {
          console.error(`❌ Ошибка для кошелька ${i + 1}: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
        }
      }
    }

  } catch (error) {
    console.error(`❌ Критическая ошибка: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
    process.exit(1)
  }
}

// Запуск программы
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ Необработанная ошибка:', error)
    process.exit(1)
  })
}
