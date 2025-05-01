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

  constructor(options: Options, openaiOptions: OpenAIOptions) {
    this.options = options
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
        "OPENAI_API_KEY is missing, cannot initialize OpenAI clients"
      )
    }
    // choose client based on experimental model list
    if (options.isExperimentalModel(openaiOptions.model)) {
      // use official OpenAI SDK for experimental models
      this.openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: options.apiBaseUrl
      })
    } else {
      // use ChatGPTAPI for existing models
      // pass prepared system message
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
      const resp = await this.openaiClient.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: this.systemMessageContent },
          { role: 'user', content: message }
        ]
      })
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
