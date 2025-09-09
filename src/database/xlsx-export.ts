import ExcelJS from 'exceljs'
import { WalletData } from './types.js'

/**
 * Экспорт данных кошельков в XLSX файл
 */
export async function exportWalletsToXLSX (wallets: WalletData[], filename?: string): Promise<string> {
  // Создаем рабочую книгу
  const workbook = new ExcelJS.Workbook()

  // Создаем лист с данными кошельков
  const worksheet = workbook.addWorksheet('Кошельки')

  // Настраиваем заголовки колонок
  worksheet.columns = [
    { header: 'Адрес', key: 'address', width: 45 },
    { header: 'Аллокация (токены)', key: 'allocation', width: 20 },
    { header: 'Право на получение', key: 'isEligible', width: 18 },
    { header: 'Уже получено', key: 'hasClaimed', width: 15 },
    { header: 'Текущий баланс', key: 'tokenBalance', width: 20 }
  ]

  // Добавляем данные
  wallets.forEach(wallet => {
    worksheet.addRow({
      address: wallet.address,
      allocation: wallet.allocation,
      isEligible: wallet.is_eligible ? 'Да' : 'Нет',
      hasClaimed: wallet.has_claimed ? 'Да' : 'Нет',
      tokenBalance: wallet.token_balance || '0'
    })
  })

  // Стилизуем заголовки
  worksheet.getRow(1).font = { bold: true }
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  }

  // Создаем лист со статистикой
  const stats = calculateStats(wallets)
  const statsWorksheet = workbook.addWorksheet('Статистика')

  // Настраиваем колонки для статистики
  statsWorksheet.columns = [
    { header: 'Параметр', key: 'parameter', width: 30 },
    { header: 'Значение', key: 'value', width: 20 }
  ]

  // Добавляем статистику
  const statsData = [
    { parameter: 'Всего кошельков', value: stats.total },
    { parameter: 'Имеют право на получение', value: stats.eligible },
    { parameter: 'Уже получили токены', value: stats.claimed },
    { parameter: 'Общая аллокация (токены)', value: stats.totalAllocation },
    { parameter: 'Процент получивших', value: `${stats.claimedPercentage}%` }
  ]

  statsData.forEach(row => {
    statsWorksheet.addRow(row)
  })

  // Стилизуем заголовки статистики
  statsWorksheet.getRow(1).font = { bold: true }
  statsWorksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  }

  // Генерируем имя файла если не указано
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const defaultFilename = `linea-wallets-${timestamp}.xlsx`
  const finalFilename = filename || defaultFilename

  // Записываем файл
  await workbook.xlsx.writeFile(finalFilename)

  console.log(`📊 Данные экспортированы в файл: ${finalFilename}`)
  console.log(`📈 Экспортировано кошельков: ${wallets.length}`)

  return finalFilename
}

/**
 * Расчет статистики для экспорта
 */
function calculateStats (wallets: WalletData[]): {
  total: number
  eligible: number
  claimed: number
  totalAllocation: string
  claimedPercentage: string
} {
  const total = wallets.length
  const eligible = wallets.filter(w => w.is_eligible === 1).length
  const claimed = wallets.filter(w => w.has_claimed === 1).length

  const totalAllocation = wallets
    .filter(w => w.is_eligible === 1)
    .reduce((sum, w) => sum + parseFloat(w.allocation), 0)
    .toFixed(6)

  const claimedPercentage = eligible > 0 ? ((claimed / eligible) * 100).toFixed(1) : '0.0'

  return {
    total,
    eligible,
    claimed,
    totalAllocation,
    claimedPercentage
  }
}

/**
 * Экспорт только eligible кошельков
 */
export async function exportEligibleWalletsToXLSX (wallets: WalletData[], filename?: string): Promise<string> {
  const eligibleWallets = wallets.filter(w => w.is_eligible === 1)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const defaultFilename = `linea-eligible-wallets-${timestamp}.xlsx`
  const finalFilename = filename || defaultFilename

  return exportWalletsToXLSX(eligibleWallets, finalFilename)
}

/**
 * Экспорт только unclaimed кошельков
 */
export async function exportUnclaimedWalletsToXLSX (wallets: WalletData[], filename?: string): Promise<string> {
  const unclaimedWallets = wallets.filter(w => w.is_eligible === 1 && w.has_claimed === 0)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const defaultFilename = `linea-unclaimed-wallets-${timestamp}.xlsx`
  const finalFilename = filename || defaultFilename

  return exportWalletsToXLSX(unclaimedWallets, finalFilename)
}
