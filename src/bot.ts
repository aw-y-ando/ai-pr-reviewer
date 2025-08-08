import './fetch-polyfill'

import {info, setFailed, warning} from '@actions/core'
import {
  ChatGPTAPI,
  ChatGPTError,
  ChatMessage,
  SendMessageOptions
  // eslint-disable-next-line import/no-unresolved
} from 'chatgpt'
import OpenAI from 'openai'
import pRetry from 'p-retry'
import {OpenAIOptions, Options} from './options'

// define type to save parentMessageId and conversationId
export interface Ids {
  parentMessageId?: string
  conversationId?: string
}

export class Bot {
  private readonly api: ChatGPTAPI | null = null // existing ChatGPTAPI client
  private readonly openaiClient: OpenAI | null = null // new OpenAI SDK client
  private readonly model: string // model name
  private readonly systemMessageContent: string // system message for both clients

  private readonly options: Options
  private readonly openaiOptions: OpenAIOptions

  constructor(options: Options, openaiOptions: OpenAIOptions) {
    this.options = options
    this.openaiOptions = openaiOptions
    this.model = openaiOptions.model
    // build common system message with cutoff and date
    const currentDate = new Date().toISOString().split('T')[0]
    this.systemMessageContent = `${options.systemMessage}
Knowledge cutoff: ${openaiOptions.tokenLimits.knowledgeCutOff}
Current date: ${currentDate}

IMPORTANT: Entire response must be in the language with ISO code: ${options.language}
`
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        'OPENAI_API_KEY is missing, cannot initialize OpenAI clients'
      )
    }
    // choose client based on model type
    if (options.isOldChatGptApiModel(openaiOptions.model)) {
      // use ChatGPTAPI for specific models (gpt-4.1 series)
      this.api = new ChatGPTAPI({
        apiBaseUrl: options.apiBaseUrl,
        systemMessage: this.systemMessageContent,
        apiKey: process.env.OPENAI_API_KEY,
        apiOrg: process.env.OPENAI_API_ORG ?? undefined,
        debug: options.debug,
        maxModelTokens: openaiOptions.tokenLimits.maxTokens,
        maxResponseTokens: openaiOptions.tokenLimits.responseTokens,
        completionParams: {
          temperature: options.openaiModelTemperature,
          model: this.model
        }
      })
    } else {
      // use official OpenAI SDK for all other models (gpt-5 series, etc.)
      this.openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: options.apiBaseUrl
      })
    }
  }

  chat = async (message: string, ids: Ids): Promise<[string, Ids]> => {
    try {
      return await this.chat_(message, ids)
    } catch (e: unknown) {
      if (e instanceof ChatGPTError) {
        warning(`Failed to chat: ${e}, backtrace: ${e.stack}`)
      }
      return ['', {}]
    }
  }

  private readonly chat_ = async (
    message: string,
    ids: Ids
  ): Promise<[string, Ids]> => {
    // record timing
    const start = Date.now()
    if (!message) return ['', {}]

    // branch by client
    if (this.openaiClient) {
      // official OpenAI SDK for experimental models
      const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
        model: this.model,
        messages: [
          {role: 'system', content: this.systemMessageContent},
          {role: 'user', content: message}
        ],
        // eslint-disable-next-line camelcase
        max_completion_tokens: this.openaiOptions.tokenLimits.responseTokens
      }

      // GPT-5系モデルはtemperature=0をサポートしていないため、デフォルト値を使用
      const gpt5Models = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano']
      if (!gpt5Models.some(model => this.model.includes(model))) {
        requestParams.temperature = this.options.openaiModelTemperature
      }

      const resp = await this.openaiClient.chat.completions.create(
        requestParams
      )
      const text = resp.choices?.[0]?.message?.content ?? ''
      const newIds: Ids = {
        parentMessageId: resp.id,
        conversationId: ids.conversationId ?? resp.id
      }
      return [text, newIds]
    }
    let response: ChatMessage | undefined

    if (this.api != null) {
      const opts: SendMessageOptions = {
        timeoutMs: this.options.openaiTimeoutMS
      }
      if (ids.parentMessageId) {
        opts.parentMessageId = ids.parentMessageId
      }
      try {
        response = await pRetry(() => this.api!.sendMessage(message, opts), {
          retries: this.options.openaiRetries
        })
      } catch (e: unknown) {
        if (e instanceof ChatGPTError) {
          info(
            `response: ${response}, failed to send message to openai: ${e}, backtrace: ${e.stack}`
          )
        }
      }
      const end = Date.now()
      info(`response: ${JSON.stringify(response)}`)
      info(
        `openai sendMessage (including retries) response time: ${
          end - start
        } ms`
      )
    } else {
      setFailed('The OpenAI API is not initialized')
    }
    let responseText = ''
    if (response != null) {
      responseText = response.text
    } else {
      warning('openai response is null')
    }
    // remove the prefix "with " in the response
    if (responseText.startsWith('with ')) {
      responseText = responseText.substring(5)
    }
    if (this.options.debug) {
      info(`openai responses: ${responseText}`)
    }
    const newIds: Ids = {
      parentMessageId: response?.id,
      conversationId: response?.conversationId
    }
    return [responseText, newIds]
  }
}
