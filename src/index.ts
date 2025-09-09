import { setupEncoding } from './encoding-setup.js'
import { KeyEncryption } from './key-encryption.js'
import { initializeDatabase, closeDatabase, cleanupTempFiles } from './database/database-init.js'
import type Database from 'better-sqlite3'
import { WalletDatabase } from './database/wallet-database.js'
import { exportWalletsToXLSX } from './database/xlsx-export.js'
import { privateKeyToAccount } from 'viem/accounts'
import prompts from 'prompts'
import { createWalletResultsTable, createStatsTable, type WalletResult, type StatsData } from './table-display.js'
import { Banner } from './banner.js'

// Константы для дат клейма (из официальной документации Linea)
const CLAIM_START_DATE = new Date('2025-09-10T08:00:00Z') // 10 сентября 2025, 08:00 UTC (10:00 +02:00)

/**
 * Показать главное меню
 */
async function showMainMenu (): Promise<void> {
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: 'Выберите режим работы:',
    choices: [
      { title: '🔍 Проверка Eligble ', value: 'check' },
      { title: '🚀 Клайм', value: 'claim' },
      { title: '📊 Экспорт данных в XLSX', value: 'export' },
      { title: '❌ Выход', value: 'exit' }
    ],
    initial: 0
  })

  if (!response.action) {
    console.log('❌ Действие не выбрано')
    return
  }

  switch (response.action) {
  case 'check':
    await handleCheckMode()
    break
  case 'claim':
    await handleClaimMode()
    break
  case 'export':
    await handleExportMode()
    break
  case 'exit':
    console.log('👋 До свидания!')
    return
  default:
    console.log('❌ Неверный выбор')
  }

  // Показать меню снова, если не выход
  if (response.action !== 'exit') {
    console.log('')
    await showMainMenu()
  }
}

/**
 * Параллельная обработка адресов с контролем скорости
 */
async function processAddressesInParallel (checker: { checkEligibility: (address: string, orderIndex?: number) => Promise<{ allocation: string, isEligible: boolean, hasClaimed: boolean }>, getTokenBalance: (address: string) => Promise<string> }, addresses: { address: string, orderIndex: number }[]): Promise<WalletResult[]> {
  const BATCH_SIZE = 20 // Количество одновременных запросов
  const DELAY_MS = 200 // Задержка между батчами (200ms = 100 запросов в секунду)
  const results: WalletResult[] = []

  console.log(`📊 Обрабатываем ${addresses.length} адресов батчами по ${BATCH_SIZE}`)

  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE)

    // Создаем промисы для всех адресов в батче с сохранением индекса
    const batchPromises = batch.map(async (addressData) => {
      const { address, orderIndex } = addressData

      if (!address) {
        return {
          address: `empty_${orderIndex}`,
          allocation: '0',
          isEligible: false,
          hasClaimed: false,
          tokenBalance: '0',
          orderIndex
        }
      }

      try {
        const eligibility = await checker.checkEligibility(address, orderIndex)
        let tokenBalance = '0'

        if (eligibility.allocation !== '0') {
          tokenBalance = await checker.getTokenBalance(address)
        }

        return {
          address,
          allocation: eligibility.allocation,
          isEligible: eligibility.isEligible,
          hasClaimed: eligibility.hasClaimed,
          tokenBalance,
          orderIndex
        }
      } catch {
        return {
          address,
          allocation: '0',
          isEligible: false,
          hasClaimed: false,
          tokenBalance: 'Ошибка',
          orderIndex
        }
      }
    })

    // Ждем завершения всех промисов в батче
    const batchResults = await Promise.all(batchPromises)

    // Сортируем результаты батча по orderIndex для сохранения порядка
    batchResults.sort((a, b) => a.orderIndex - b.orderIndex)
    results.push(...batchResults)

    // Показываем прогресс-бар
    const processed = Math.min(i + BATCH_SIZE, addresses.length)
    const progressBar = Banner.createProgressBar(processed, addresses.length, 50)
    process.stdout.write(`\r🔄 ${progressBar}`)

    // Задержка между батчами (кроме последнего)
    if (i + BATCH_SIZE < addresses.length) {
      await new Promise(resolve => global.setTimeout(resolve, DELAY_MS))
    }
  }

  console.log('\n✅ Обработка завершена!')
  return results
}

/**
 * Обработка режима проверки
 */
async function handleCheckMode (): Promise<void> {
  try {
    const { LineaAirdropChecker } = await import('./linea-airdrop.js')
    const checker = new LineaAirdropChecker()
    await checker.initialize()

    // Получаем адреса из приватных ключей
    const addresses = await getWalletAddressesFromPrivateKeys()

    if (addresses.length === 0) {
      console.log('❌ Не найдено приватных ключей или не удалось получить адреса')
      console.log('💡 Убедитесь что файл keys.txt существует и содержит валидные приватные ключи')
      return
    }

    console.log(`🔍 Найдено ${addresses.length} адресов для проверки\n`)

    let totalEligible = 0
    let totalClaimed = 0
    let totalAllocation = 0
    const results: WalletResult[] = []
    const addressesToCheck: { address: string, orderIndex: number }[] = []

    // Сначала проверяем базу данных для всех адресов
    let hasDataInDb = false
    let dbProgressShown = false

    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i]

      if (!address) {
        continue
      }

      try {
        const database = checker.getDatabase()
        if (!database) {
          throw new Error('База данных не инициализирована')
        }

        const walletData = await database.getWalletData(address)

        if (walletData) {
          // Данные найдены в БД - используем их
          if (!hasDataInDb) {
            hasDataInDb = true
            console.log('📊 Загружаем данные из базы данных...')
            dbProgressShown = true
          }

          results.push({
            address,
            allocation: walletData.allocation,
            isEligible: Boolean(walletData.is_eligible),
            hasClaimed: Boolean(walletData.has_claimed),
            tokenBalance: walletData.token_balance || '0',
            orderIndex: i
          })

          if (walletData.is_eligible) {
            totalEligible++
            totalAllocation += parseFloat(walletData.allocation)
          }

          if (walletData.has_claimed) {
            totalClaimed++
          }
        } else {
          // Данных нет в БД - добавим в список для проверки через RPC с индексом
          addressesToCheck.push({ address, orderIndex: i })
        }
      } catch {
        addressesToCheck.push({ address, orderIndex: i })
      }

      // Показываем прогресс-бар только если есть данные в БД
      if (hasDataInDb) {
        const progressBar = Banner.createProgressBar(i + 1, addresses.length, 50)
        process.stdout.write(`\r📊 ${progressBar}`)
      }
    }

    if (dbProgressShown) {
      console.log('\n✅ Загрузка из БД завершена!')
    }

    // Проверяем адреса, которых нет в БД, через RPC (параллельно)
    if (addressesToCheck.length > 0) {
      console.log(`\n🔄 Проверяем ${addressesToCheck.length} новых адресов`)
      const batchResults = await processAddressesInParallel(checker, addressesToCheck)

      // Добавляем результаты в общий массив
      for (const result of batchResults) {
        results.push(result)

        if (result.isEligible) {
          totalEligible++
          totalAllocation += parseFloat(result.allocation)
        }

        if (result.hasClaimed) {
          totalClaimed++
        }
      }
    }

    // Отображаем красивую таблицу с результатами
    console.log('\n' + createWalletResultsTable(results))

    // Отображаем статистику
    const stats: StatsData = {
      total: addresses.length,
      eligible: totalEligible,
      claimed: totalClaimed,
      totalAllocation,
      claimStart: CLAIM_START_DATE,
      claimEnd: new Date(1765324799 * 1000)
    }
    console.log(createStatsTable(stats))

  } catch (error) {
    console.error('❌ Ошибка при проверке:', error instanceof Error ? error.message : 'Неизвестная ошибка')
  } finally {
    // Закрываем соединение с БД
    const { LineaAirdropChecker } = await import('./linea-airdrop.js')
    const checker = new LineaAirdropChecker()
    await checker.close()
  }
}

/**
 * Получение адресов кошельков из приватных ключей
 */
async function getWalletAddressesFromPrivateKeys (): Promise<string[]> {
  try {
    // Получаем приватные ключи (зашифрованные или открытые)
    const privateKeys = await getPrivateKeys()

    if (privateKeys.length === 0) {
      console.log('❌ Не найдено приватных ключей')
      return []
    }

    const addresses: string[] = []

    for (const privateKey of privateKeys) {
      try {
        // Создаем аккаунт из приватного ключа
        const account = privateKeyToAccount(privateKey as `0x${string}`)
        addresses.push(account.address)
      } catch (error) {
        console.log(`❌ Ошибка при обработке приватного ключа: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
      }
    }

    return addresses
  } catch (error) {
    console.log(`❌ Ошибка при получении приватных ключей: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
    return []
  }
}

/**
 * Получение приватных ключей (зашифрованных или открытых)
 */
async function getPrivateKeys (): Promise<string[]> {
  // Проверяем наличие зашифрованных ключей
  if (KeyEncryption.hasEncryptedKeys()) {
    console.log('🔐 Используем зашифрованные приватные ключи')
    return await KeyEncryption.promptPasswordWithRetry()
  }

  // Проверяем наличие открытых ключей
  if (KeyEncryption.hasPlainKeys()) {
    console.log('⚠️ Используем открытые приватные ключи (рекомендуется зашифровать)')
    const fs = await import('fs')
    const content = fs.readFileSync('keys.txt', 'utf8')
    const lines = content.split('\n')
    const privateKeys: string[] = []

    for (const line of lines) {
      const trimmedLine = line.trim()
      if (trimmedLine && !trimmedLine.startsWith('#')) {
        let privateKey = trimmedLine
        if (!privateKey.startsWith('0x')) {
          privateKey = '0x' + privateKey
        }
        if (/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
          privateKeys.push(privateKey)
        }
      }
    }

    return privateKeys
  }

  console.log('❌ Не найдено файлов с приватными ключами (keys.txt или зашифрованные файлы)')
  return []
}

/**
 * Обработка режима клейма
 */
async function handleClaimMode (): Promise<void> {
  try {
    const { LineaAirdropChecker } = await import('./linea-airdrop.js')
    const checker = new LineaAirdropChecker()
    await checker.initialize()

    let privateKeys: string[] = []

    // Автоматическое определение источника ключей
    const hasEncryptedKeys = KeyEncryption.hasEncryptedKeys()
    const hasPlainKeys = KeyEncryption.hasPlainKeys()

    if (hasEncryptedKeys) {
      // Приоритет зашифрованным ключам
      console.log('🔐 Используем зашифрованные ключи (keys.encrypted)')
      privateKeys = await KeyEncryption.promptPasswordWithRetry()
    } else if (hasPlainKeys) {
      // Используем открытые ключи из файла
      console.log('📄 Используем открытые ключи из файла (keys.txt)')
      privateKeys = await getPrivateKeys()
    } else {
      // Нет файлов с ключами
      console.log('❌ Файлы с приватными ключами не найдены')
      console.log('💡 Создайте файл keys.txt с приватными ключами или зашифруйте их')
      console.log('📝 Формат файла keys.txt: один приватный ключ на строку (с 0x или без)')
      return
    }

    if (!privateKeys || privateKeys.length === 0) {
      console.log('❌ Приватные ключи не найдены')
      return
    }

    // Настройка задержек между клаймами
    const delayConfig = await configureDelays()
    if (!delayConfig) {
      console.log('❌ Настройка задержек отменена')
      return
    }

    console.log(`\n🚀 Начинаем автоматический клайм для ${privateKeys.length} кошельков`)
    if (delayConfig.enabled) {
      console.log(`⏱️  Случайные задержки: ${delayConfig.minMinutes}-${delayConfig.maxMinutes} минут`)
    } else {
      console.log('⚡ Без задержек')
    }

    let successCount = 0
    let skipCount = 0
    let errorCount = 0

    // Обрабатываем каждый ключ
    for (let i = 0; i < privateKeys.length; i++) {
      const privateKey = privateKeys[i]

      if (!privateKey) {
        console.log(`❌ Пропускаем пустой ключ ${i + 1}`)
        skipCount++
        continue
      }

      try {
        console.log(`\n🔄 Обрабатываем кошелек ${i + 1}/${privateKeys.length}`)

        await checker.connectWallet(privateKey)
        const address = checker.getWalletAddress()

        // Проверяем право на клейм
        const eligibility = await checker.checkEligibility(address, i)

        console.log('\n📊 Результаты:')
        console.log(`💰 Аллокация: ${eligibility.allocation} токенов`)
        console.log(`✅ Право на получение: ${eligibility.isEligible ? 'Да' : 'Нет'}`)
        console.log(`🎯 Уже получено: ${eligibility.hasClaimed ? 'Да' : 'Нет'}`)

        if (eligibility.isEligible) {
          console.log(`🎯 Автоматически получаем ${eligibility.allocation} токенов...`)
          await checker.claimTokens()
          successCount++
          console.log('✅ Клайм успешно выполнен!')
        } else {
          console.log('⏭️  Пропускаем - нет права на получение или уже получено')
          skipCount++
        }

        // Добавляем задержку между кошельками (кроме последнего)
        if (i < privateKeys.length - 1 && delayConfig.enabled) {
          const delayMinutes = Math.random() * (delayConfig.maxMinutes - delayConfig.minMinutes) + delayConfig.minMinutes
          const delayMs = Math.round(delayMinutes * 60 * 1000)
          const delaySeconds = Math.round(delayMs / 1000)

          console.log(`\n⏳ Ожидание ${delaySeconds} секунд (${delayMinutes.toFixed(1)} мин) до следующего кошелька...`)
          await sleep(delayMs)
        }

      } catch (error) {
        console.error(`❌ Ошибка для кошелька ${i + 1}: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
        errorCount++
      }
    }

    // Показываем итоговую статистику
    console.log('\n📈 Итоговая статистика:')
    console.log('========================')
    console.log(`✅ Успешно получено: ${successCount}`)
    console.log(`⏭️  Пропущено: ${skipCount}`)
    console.log(`❌ Ошибок: ${errorCount}`)
    console.log(`📊 Всего обработано: ${privateKeys.length}`)

  } catch (error) {
    console.error('❌ Ошибка при клейме:', error instanceof Error ? error.message : 'Неизвестная ошибка')
  } finally {
    // Закрываем соединение с БД
    const { LineaAirdropChecker } = await import('./linea-airdrop.js')
    const checker = new LineaAirdropChecker()
    await checker.close()
  }
}

/**
 * Обработка режима экспорта
 */
async function handleExportMode (): Promise<void> {
  let db: Database.Database | null = null
  try {
    // Инициализируем БД
    db = initializeDatabase()
    const walletDb = new WalletDatabase(db)

    // Получаем статистику
    const stats = await walletDb.getStats()

    if (stats.total === 0) {
      console.log('❌ В базе данных нет кошельков для экспорта')
      console.log('💡 Сначала выполните проверку кошельков')
      return
    }

    console.log('\n📊 Статистика базы данных:')
    console.log('============================')
    console.log(`📍 Всего кошельков: ${stats.total}`)
    console.log(`✅ Имеют право на получение: ${stats.eligible}`)
    console.log(`🎯 Уже получили токены: ${stats.claimed}`)
    console.log(`💰 Общая аллокация: ${stats.totalAllocation} токенов`)

    // Выбор типа экспорта
    const { exportType } = await prompts({
      type: 'select',
      name: 'exportType',
      message: 'Выберите тип экспорта:',
      choices: [
        { title: '📋 Все кошельки', value: 'all' },
        { title: '✅ Только eligible кошельки', value: 'eligible' },
        { title: '🎯 Только unclaimed кошельки', value: 'unclaimed' }
      ],
      initial: 0
    })

    if (!exportType) {
      console.log('❌ Тип экспорта не выбран')
      return
    }

    // Получаем данные в зависимости от выбора
    let wallets
    let filename

    switch (exportType) {
    case 'all':
      wallets = await walletDb.getAllWallets()
      filename = `linea-all-wallets-${new Date().toISOString().slice(0, 10)}.xlsx`
      break
    case 'eligible':
      wallets = await walletDb.getEligibleWallets()
      filename = `linea-eligible-wallets-${new Date().toISOString().slice(0, 10)}.xlsx`
      break
    case 'unclaimed':
      wallets = await walletDb.getUnclaimedWallets()
      filename = `linea-unclaimed-wallets-${new Date().toISOString().slice(0, 10)}.xlsx`
      break
    default:
      console.log('❌ Неверный тип экспорта')
      return
    }

    if (wallets.length === 0) {
      console.log('❌ Нет данных для экспорта выбранного типа')
      return
    }

    // Экспортируем в XLSX
    console.log(`\n📊 Экспортируем ${wallets.length} кошельков...`)
    const exportedFile = await exportWalletsToXLSX(wallets, filename)

    console.log('\n✅ Экспорт завершен успешно!')
    console.log(`📁 Файл сохранен: ${exportedFile}`)

  } catch (error) {
    console.error('❌ Ошибка при экспорте:', error instanceof Error ? error.message : 'Неизвестная ошибка')
  } finally {
    // Закрываем соединение с БД и очищаем временные файлы
    if (db) {
      closeDatabase(db)
      cleanupTempFiles()
    }
  }
}

/**
 * Настройка задержек между клаймами
 */
async function configureDelays (): Promise<{
  enabled: boolean
  minMinutes: number
  maxMinutes: number
} | null> {
  const { useDelays } = await prompts({
    type: 'confirm',
    name: 'useDelays',
    message: 'Использовать случайные задержки между клаймами?',
    initial: true
  })

  if (!useDelays) {
    return { enabled: false, minMinutes: 0, maxMinutes: 0 }
  }

  const { minMinutes } = await prompts({
    type: 'number',
    name: 'minMinutes',
    message: 'Минимальная задержка (в минутах):',
    initial: 1,
    min: 0.1,
    max: 60,
    float: true,
    validate: (value: number) => {
      if (value <= 0) return 'Минимальная задержка должна быть больше 0'
      if (value > 60) return 'Максимальная задержка не должна превышать 60 минут'
      return true
    }
  })

  if (minMinutes === undefined) {
    return null
  }

  const { maxMinutes } = await prompts({
    type: 'number',
    name: 'maxMinutes',
    message: 'Максимальная задержка (в минутах):',
    initial: Math.max(minMinutes + 1, 5),
    min: minMinutes,
    max: 60,
    float: true,
    validate: (value: number) => {
      if (value <= minMinutes) return `Максимальная задержка должна быть больше минимальной (${minMinutes})`
      if (value > 60) return 'Максимальная задержка не должна превышать 60 минут'
      return true
    }
  })

  if (maxMinutes === undefined) {
    return null
  }

  return { enabled: true, minMinutes, maxMinutes }
}

/**
 * Функция задержки
 */
function sleep (ms: number): Promise<void> {
  return new Promise(resolve => global.setTimeout(resolve, ms))
}

/**
 * Основная функция приложения
 * Linea Airdrop Checker & Claimer
 */
async function main (): Promise<void> {
  // Настройка кодировки для корректного отображения кириллицы
  setupEncoding()

  // Показать красивую заставку
  Banner.show()

  try {
    // Проверка и предложение шифрования при наличии keys.txt
    const shouldExit = await KeyEncryption.checkAndOfferEncryption()
    if (shouldExit) {
      return
    }

    // Показать главное меню
    await showMainMenu()

    console.log('\n✨ Приложение завершило работу успешно')
  } catch (error) {
    console.error('❌ Критическая ошибка:', error instanceof Error ? error.message : 'Неизвестная ошибка')
    process.exit(1)
  }
}

// Запуск приложения
main().catch((error) => {
  console.error('❌ Необработанная ошибка:', error)
  process.exit(1)
})
