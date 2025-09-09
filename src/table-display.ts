/**
 * Модуль для отображения красивых таблиц в консоли
 * Собственная реализация без внешних зависимостей
 */

// ANSI цветовые коды
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
}

// Интерфейс для колонки таблицы
interface TableColumn {
  name: string
  alignment?: 'left' | 'center' | 'right'
  color?: keyof typeof colors
}

// Интерфейс для строки таблицы
interface TableRow {
  [key: string]: string | number | boolean | undefined
}

// Интерфейс для опций строки
interface RowOptions {
  color?: keyof typeof colors
}

// Интерфейс для опций таблицы
interface TableOptions {
  title?: string
  columns: TableColumn[]
}

// Класс для создания таблиц
class Table {
  private options: TableOptions
  private rows: Array<{ data: TableRow; options?: RowOptions }> = []

  constructor (options: TableOptions) {
    this.options = options
  }

  addRow (rowData: TableRow, options?: RowOptions): void {
    this.rows.push({ data: rowData, ...(options && { options }) })
  }

  render (): string {
    if (this.rows.length === 0) {
      return this.renderTitle()
    }

    const columnWidths = this.calculateColumnWidths()
    let result = ''

    // Заголовок таблицы
    result += this.renderTitle()
    result += this.renderSeparator(columnWidths)
    result += this.renderHeader(columnWidths)
    result += this.renderSeparator(columnWidths)

    // Строки данных
    this.rows.forEach(({ data, options }) => {
      result += this.renderRow(data, columnWidths, options)
    })

    result += this.renderSeparator(columnWidths)
    return result
  }

  private renderTitle (): string {
    if (!this.options.title) return ''
    const title = ` ${this.options.title} `
    const width = 80 // Примерная ширина консоли
    const padding = Math.max(0, Math.floor((width - title.length) / 2))
    return ' '.repeat(padding) + colors.cyan + colors.bright + title + colors.reset + '\n'
  }

  private calculateColumnWidths (): number[] {
    const widths: number[] = []

    this.options.columns.forEach((column) => {
      let maxWidth = column.name.length

      this.rows.forEach(({ data }) => {
        const value = data[column.name]
        const valueStr = value !== undefined ? String(value) : ''
        maxWidth = Math.max(maxWidth, valueStr.length)
      })

      // Минимальная ширина колонки
      maxWidth = Math.max(maxWidth, 8)
      widths.push(maxWidth)
    })

    return widths
  }

  private renderSeparator (columnWidths: number[]): string {
    let separator = '+'
    columnWidths.forEach(width => {
      separator += '-'.repeat(width + 2) + '+'
    })
    return separator + '\n'
  }

  private renderHeader (columnWidths: number[]): string {
    let header = '|'
    this.options.columns.forEach((column, index) => {
      const width = columnWidths[index] || 8
      const alignedText = this.alignText(column.name, width, column.alignment || 'left')
      const coloredText = this.colorizeText(alignedText, column.color)
      header += ' ' + coloredText + ' |'
    })
    return header + '\n'
  }

  private renderRow (rowData: TableRow, columnWidths: number[], options?: RowOptions): string {
    let row = '|'
    this.options.columns.forEach((column, index) => {
      const width = columnWidths[index] || 8
      const value = rowData[column.name]
      const valueStr = value !== undefined ? String(value) : ''
      const alignedText = this.alignText(valueStr, width, column.alignment || 'left')
      const coloredText = this.colorizeText(alignedText, options?.color || 'white')
      row += ' ' + coloredText + ' |'
    })
    return row + '\n'
  }

  private alignText (text: string, width: number, alignment: 'left' | 'center' | 'right'): string {
    const textLength = this.getStringWidth(text)
    const padding = width - textLength

    if (padding <= 0) return text

    switch (alignment) {
    case 'center': {
      const leftPad = Math.floor(padding / 2)
      const rightPad = padding - leftPad
      return ' '.repeat(leftPad) + text + ' '.repeat(rightPad)
    }
    case 'right':
      return ' '.repeat(padding) + text
    case 'left':
    default:
      return text + ' '.repeat(padding)
    }
  }

  private colorizeText (text: string, color?: keyof typeof colors): string {
    if (!color || color === 'white') return text
    return colors[color] + text + colors.reset
  }

  private getStringWidth (str: string): number {
    // Простая реализация - считаем количество символов
    // В реальном приложении можно использовать более сложную логику для Unicode
    return str.length
  }
}

export interface WalletResult {
  address: string
  allocation: string
  isEligible: boolean
  hasClaimed: boolean
  tokenBalance?: string
  orderIndex?: number
}

export interface StatsData {
  total: number
  eligible: number
  claimed: number
  totalAllocation: number
  claimStart: Date
  claimEnd: Date
}

// Экспортируем класс Table для использования в других модулях
export { Table }

/**
 * Создание красивой таблицы с результатами проверки кошельков
 */
export function createWalletResultsTable (results: WalletResult[]): string {
  // Сортируем результаты по orderIndex если он есть
  const sortedResults = [...results].sort((a, b) => {
    if (a.orderIndex !== undefined && b.orderIndex !== undefined) {
      return a.orderIndex - b.orderIndex
    }
    return 0
  })

  const table = new Table({
    title: 'Результаты проверки кошельков',
    columns: [
      { name: '№', alignment: 'center', color: 'blue' },
      { name: 'Адрес', alignment: 'left' },
      { name: 'Аллокация', alignment: 'right', color: 'green' },
      { name: 'Eligible', alignment: 'center' },
      { name: 'Claimed', alignment: 'center' },
      { name: 'Баланс', alignment: 'right', color: 'yellow' }
    ]
  })

  sortedResults.forEach((result, index) => {
    table.addRow({
      '№': index + 1,
      'Адрес': result.address,
      'Аллокация': formatNumber(result.allocation),
      'Eligible': result.isEligible ? 'Да' : 'Нет',
      'Claimed': result.hasClaimed ? 'Да' : 'Нет',
      'Баланс': result.tokenBalance ? formatNumber(result.tokenBalance) : '0'
    }, {
      color: 'white'
    })
  })

  return table.render()
}

/**
 * Создание таблицы со статистикой
 */
export function createStatsTable (stats: StatsData): string {
  const table = new Table({
    title: 'Общая статистика',
    columns: [
      { name: 'Параметр', alignment: 'left', color: 'cyan' },
      { name: 'Значение', alignment: 'right', color: 'white' }
    ]
  })

  table.addRow({
    'Параметр': 'Всего адресов',
    'Значение': stats.total.toString()
  }, { color: 'white' })

  table.addRow({
    'Параметр': 'Eligible',
    'Значение': stats.eligible.toString()
  }, { color: stats.eligible > 0 ? 'green' : 'red' })

  table.addRow({
    'Параметр': 'Уже получили токены',
    'Значение': stats.claimed.toString()
  }, { color: stats.claimed > 0 ? 'green' : 'yellow' })

  table.addRow({
    'Параметр': 'Общая аллокация',
    'Значение': `${formatNumber(stats.totalAllocation.toString())} токенов`
  }, { color: stats.totalAllocation > 0 ? 'green' : 'red' })

  table.addRow({
    'Параметр': 'Начало клейма',
    'Значение': stats.claimStart.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' MSK'
  }, { color: 'green' })

  table.addRow({
    'Параметр': 'Окончание клейма',
    'Значение': stats.claimEnd.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' MSK'
  }, { color: 'blue' })

  return table.render()
}

/**
 * Вспомогательные функции для форматирования данных
 */

/**
 * Форматирование чисел
 */
function formatNumber (value: string): string {
  const num = parseFloat(value)
  if (isNaN(num)) return value

  if (num === 0) return '0'
  if (num < 0.000001) return num.toExponential(2)
  if (num < 1) return num.toFixed(6)

  // Возвращаем целое число без сокращений
  return Math.round(num).toString()
}
