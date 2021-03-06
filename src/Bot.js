const { Composer } = require('micro-bot')
const Telegraf = require('telegraf')
const path = require('path')

const cron = require('./cron')

const captchaList = require('./captcha')

class Bot {
  constructor(params) {
    const {
      token,
      isDev,
      botUsername,
      maxAttempts,
      captchaTimeout,
      sensitiveCase,
    } = params

    this.bot = isDev
      ? new Telegraf(token)
      : new Composer
    
    if (isDev) this.bot.launch()

    this.isDev = isDev
    this.usersBlacklist = []
    this.botUsername = botUsername
    this.maxAttempts = maxAttempts || 3
    this.captchaTimeout = captchaTimeout || 180000
    this.sensitiveCase = sensitiveCase
    this.postedLinks = []

    this.bindEvents()    
  }

  bindEvents() {
    this.bot.command('startCron', context => cron.start(context))
    this.bot.on('new_chat_members', this.onNewChatMembers.bind(this))
    this.bot.on('message', this.onNewMessage.bind(this))
  }

  getRssFeed(context) {
    context.webhookReply = false
    
    const checkItems = feed => {
      console.log(JSON.stringify(feed, null, 2))
    }

    rss.parseURL('https://www.noticiasaominuto.com/rss/pais').then(checkItems)
  }

  getRandomCaptcha() {
    const randomNumber = Math.floor(Math.random() * captchaList.length) + 0
    return captchaList[randomNumber]
  }

  setMessages({ welcome, timeout, attemptFail, attemptsOver, captchaSuccess }) {
    this.welcomeMessage = welcome
    this.timeoutMessage = timeout
    this.attemptFailMessage = attemptFail
    this.attemptsOverMessage = attemptsOver
    this.captchaSuccessMessage = captchaSuccess
  }

  replaceAll(str, find, replace) {
    const escapedFind = find.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '\\$1')
    return str.replace(new RegExp(escapedFind, 'g'), replace)
  }

  parseMessage({ user, message }) {
    let msg = this.replaceAll(message, '$firstname', user.first_name)
    msg = this.replaceAll(msg, '$lastname', user.last_name || '')
    msg = this.replaceAll(msg, '$username', user.username ? `@${user.username}` : '')
    msg = this.replaceAll(msg, '$attemptCount', user.attempt)

    return msg
  }

  addUserToBlacklist(user) {
    this.usersBlacklist.push(user)
  }

  getUserFromBlacklist(userId) {
    return this.usersBlacklist.find(usr => usr.id === userId)
  }

  removeUserFromBlacklist(userId) {
    this.usersBlacklist = this.usersBlacklist.filter(usr => usr.id !== userId)
  }

  updateUserAttempts({ userId, attempt }) {
    const user = this.getUserFromBlacklist(userId)

    user.attempt = attempt

    this.usersBlacklist = this.usersBlacklist.map(usr => 
      usr.id === userId
        ? user 
        : usr
    )
  }

  updateUserMessages({ userId, messagesIds }) {
    const user = this.getUserFromBlacklist(userId)

    const messages = user.messages.concat(messagesIds)
    user.messages = messages

    this.usersBlacklist = this.usersBlacklist.map(usr => 
      usr.id === userId
        ? user 
        : usr
    )
  }

  deleteMessages({ context, messages }) {
    messages.forEach(id => {
      if (id) context.deleteMessage(id).catch(console.log)
    })
  }

  acceptUser({ context, user }) {
    this.removeUserFromBlacklist(user.id)

    const message = this.parseMessage({
      user,
      message: this.captchaSuccessMessage,
    })

    context.reply(message)

    this.deleteMessages({
      context,
      messages: user.messages,
    })
  }

  rejectUser({ context, user, message }) {
    const userInBlacklist = this.getUserFromBlacklist(user.id)

    if (userInBlacklist) {
      this.removeUserFromBlacklist(user.id)
      this.deleteMessages({
        context,
        messages: userInBlacklist.messages,
      })
      context.kickChatMember(user.id)
      context.reply(message)
    }
  }

  async newAttempt({ context, user, messageId }) {
    context.webhookReply = false

    user.attempt--
    const canTryAgain = (user.attempt < this.maxAttempts)

    if (!canTryAgain) {
      const attemptsOver = this.parseMessage({
        user,
        message: this.attemptsOverMessage,
      })
      
      this.updateUserMessages({
        userId: user.id,
        messagesIds: [
          messageId,
        ],
      })

      return this.rejectUser({
        context,
        user,
        message: attemptsOver,
      })
    }

    const attemptFail = this.parseMessage({
      user,
      message: this.attemptFailMessage,
    })

    const failMessage = await context.telegram.sendMessage(context.message.chat.id, attemptFail)
    
    this.updateUserAttempts({
      userId: user.id,
      attempt: user.attempt,
    })

    this.updateUserMessages({
      userId: user.id,
      messagesIds: [
        messageId,
        failMessage.message_id,
      ],
    })
  }

  async onNewChatMembers(context) {
    context.webhookReply = false

    const { message } = context
    const { new_chat_participant } = message
    const { id, first_name, last_name, username } = new_chat_participant

    if (username === this.botUsername) return

    const user = {
      id, 
      first_name,
      last_name,
      username,
    }

    const captcha = this.getRandomCaptcha() || captchaList[0]

    const welcomeMessage = this.parseMessage({
      user,
      message: this.welcomeMessage
    })

    const welcome = await context.replyWithPhoto({ 
      source: path.join(__dirname, `/captcha/images/${captcha.image}`)
    }, { 
      caption: welcomeMessage
    })

    this.addUserToBlacklist({
      ...user,
      captcha,
      attempt: this.maxAttempts,
      messages: [welcome.message_id]
    })

    setTimeout(() => {
      const userInBlacklist = this.getUserFromBlacklist(user.id)

      if (userInBlacklist) {
        const message = this.parseMessage({
          user,
          message: this.timeoutMessage,
        })
        
        this.rejectUser({
          user, 
          context, 
          message,
        })
      }
    }, this.captchaTimeout)
  }

  onNewMessage(context) {
    const { message } = context
    const { message_id, from, text } = message

    const userInBlacklist = this.getUserFromBlacklist(from.id)    
    
    if (userInBlacklist) {
      const { captcha } = userInBlacklist
      const { code } = captcha

      const userSolvedCaptcha = this.sensitiveCase
        ? (text === code)
        : (text.toLowerCase() === code.toLowerCase())

      if(!userSolvedCaptcha) {
        return this.newAttempt({
          context,
          user: userInBlacklist,
          messageId: message_id,
        })        
      }

      this.updateUserMessages({
        userId: userInBlacklist.id,
        messagesIds: [message_id],
      })

      this.acceptUser({
        context, 
        user: userInBlacklist, 
      })      
    }
  }
}

module.exports = Bot