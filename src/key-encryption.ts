import * as crypto from 'crypto'
import * as fs from 'fs'
import prompts from 'prompts'

export class KeyEncryption {
  private static readonly ALGORITHM = 'aes-256-cbc'
  private static readonly ENCRYPTED_FILE = 'keys.encrypted'
  private static readonly SALT_FILE = 'keys.salt'

  // Деривация ключа из пароля
  private static deriveKey (password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256')
  }

  // Шифрование ключей
  static encryptKeys (privateKeys: string[], password: string): void {
    const salt = crypto.randomBytes(32)
    const key = this.deriveKey(password, salt)
    const iv = crypto.randomBytes(16)

    const keysData = privateKeys.join('\n')
    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv)

    let encrypted = cipher.update(keysData, 'utf8', 'hex')
    encrypted += cipher.final('hex')

    const encryptedData = iv.toString('hex') + ':' + encrypted

    fs.writeFileSync(this.ENCRYPTED_FILE, encryptedData)
    fs.writeFileSync(this.SALT_FILE, salt.toString('hex'))
  }

  // Расшифровка ключей с правильной обработкой ошибок
  static decryptKeys (password: string): string[] {
    if (!fs.existsSync(this.ENCRYPTED_FILE) || !fs.existsSync(this.SALT_FILE)) {
      throw new Error('Зашифрованные файлы не найдены')
    }

    try {
      const saltHex = fs.readFileSync(this.SALT_FILE, 'utf8')
      const salt = Buffer.from(saltHex, 'hex')
      const key = this.deriveKey(password, salt)

      const encryptedData = fs.readFileSync(this.ENCRYPTED_FILE, 'utf8')
      const [ivHex, encrypted] = encryptedData.split(':')

      if (!ivHex || !encrypted) {
        throw new Error('invalid_format')
      }

      const iv = Buffer.from(ivHex, 'hex')

      const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv)
      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')

      return decrypted.split('\n').filter(key => key.trim())
    } catch {
      // Возвращаем понятную ошибку без технических деталей
      throw new Error('WRONG_PASSWORD')
    }
  }

  // Проверка наличия зашифрованных ключей
  static hasEncryptedKeys (): boolean {
    return fs.existsSync(this.ENCRYPTED_FILE) && fs.existsSync(this.SALT_FILE)
  }

  // Проверка наличия открытых ключей
  static hasPlainKeys (): boolean {
    return fs.existsSync('keys.txt')
  }

  // Безопасный запрос пароля с повторными попытками
  static async promptPasswordWithRetry (): Promise<string[]> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const response = await prompts({
          type: 'invisible',
          name: 'password',
          message: 'Введите пароль для расшифровки:'
        })

        if (!response.password) {
          console.log('❌ Пароль не может быть пустым.')
          continue
        }

        const keys = this.decryptKeys(response.password)
        return keys
      } catch (error) {
        if (error instanceof Error && error.message === 'WRONG_PASSWORD') {
          console.log('❌ Неверный пароль. Повторите попытку.')
          continue
        }
        throw error
      }
    }
  }

  // Проверка и предложение шифрования при старте
  static async checkAndOfferEncryption (): Promise<boolean> {
    if (this.hasPlainKeys() && !this.hasEncryptedKeys()) {
      console.log('\n🔐 Обнаружен файл keys.txt с открытыми приватными ключами')
      console.log('⚠️  Рекомендуется зашифровать ключи для безопасности')

      const response = await prompts({
        type: 'confirm',
        name: 'shouldEncrypt',
        message: 'Хотите зашифровать ключи сейчас?',
        initial: true
      })

      if (response.shouldEncrypt) {1
        try {
          await this.migratePlainKeys()
          console.log('\n✅ Шифрование завершено!')
          console.log('🔄 Перезапустите приложение: npm start')
          console.log('🗑️  Удалите файл keys.txt вручную для безопасности')
          return true
        } catch (error) {
          console.error('❌ Ошибка при шифровании:', error instanceof Error ? error.message : 'Неизвестная ошибка')
          process.exit(1)
        }
      }
    }
    return false
  }

  // Безопасный ввод пароля (скрытый)
  private static async promptPassword (message: string = 'Введите пароль: '): Promise<string> {
    const response = await prompts({
      type: 'invisible',
      name: 'password',
      message
    })
    return response.password || ''
  }

  // Ввод пароля с подтверждением
  static async promptPasswordWithConfirmation (): Promise<string> {
    const userPassword = await this.promptPassword('Введите пароль для шифрования: ')

    if (userPassword.length < 6) {
      throw new Error('Пароль должен содержать минимум 6 символов')
    }

    const confirmPassword = await this.promptPassword('Подтвердите пароль: ')

    if (userPassword !== confirmPassword) {
      throw new Error('Пароли не совпадают')
    }

    return userPassword
  }

  // Миграция открытых ключей в зашифрованные
  static async migratePlainKeys (): Promise<void> {
    if (!this.hasPlainKeys()) {
      throw new Error('Файл keys.txt не найден')
    }

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

    if (privateKeys.length === 0) {
      throw new Error('Не найдено валидных приватных ключей в файле keys.txt')
    }

    const password = await this.promptPasswordWithConfirmation()
    this.encryptKeys(privateKeys, password)

    console.log(`✅ Успешно зашифровано ${privateKeys.length} приватных ключей`)
  }
}
