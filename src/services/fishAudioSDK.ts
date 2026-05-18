import { Session, WebSocketSession, TTSRequest, ReferenceAudio } from 'fish-audio-sdk';
import type { TTSRequestOptions } from 'fish-audio-sdk/dist/schemas.js';
import {
  TTSParams,
  TTSResponse,
  FishAudioError,
  ErrorCode
} from '../types/index.js';
import { loadConfig } from '../utils/config.js';
import { createWriteStream } from 'fs';
import { Writable } from 'stream';

interface ExtendedOptions {
  temperature?: number;
  topP?: number;
  maxNewTokens?: number;
  repetitionPenalty?: number;
  minChunkLength?: number;
  conditionOnPreviousChunks?: boolean;
  earlyStopThreshold?: number;
  normalizeLoudness?: boolean;
  /** Multi-speaker reference IDs (s2-pro only). When set, overrides the SDK's single referenceId in the serialized body. */
  referenceIds?: string[];
}

/**
 * Extended TTSRequest that adds s2-pro-era parameters on top of the SDK's native fields.
 * The SDK schema lags the public API, so we serialize the extras in toJSON().
 */
class ExtendedTTSRequest extends TTSRequest {
  private _extras: ExtendedOptions;

  constructor(text: string, options: TTSRequestOptions & ExtendedOptions = {}) {
    const {
      temperature,
      topP,
      maxNewTokens,
      repetitionPenalty,
      minChunkLength,
      conditionOnPreviousChunks,
      earlyStopThreshold,
      normalizeLoudness,
      referenceIds,
      ...sdkOptions
    } = options;
    super(text, sdkOptions);
    this._extras = {
      temperature,
      topP,
      maxNewTokens,
      repetitionPenalty,
      minChunkLength,
      conditionOnPreviousChunks,
      earlyStopThreshold,
      normalizeLoudness,
      referenceIds,
    };
  }

  toJSON() {
    const base: any = super.toJSON();
    const e = this._extras;

    if (e.normalizeLoudness !== undefined && base.prosody) {
      base.prosody = { ...base.prosody, normalize_loudness: e.normalizeLoudness };
    }

    // Multi-speaker (s2-pro): API accepts reference_id as an array of voice model IDs.
    if (e.referenceIds && e.referenceIds.length > 0) {
      base.reference_id = e.referenceIds;
    }

    return {
      ...base,
      ...(e.temperature !== undefined && { temperature: e.temperature }),
      ...(e.topP !== undefined && { top_p: e.topP }),
      ...(e.maxNewTokens !== undefined && { max_new_tokens: e.maxNewTokens }),
      ...(e.repetitionPenalty !== undefined && { repetition_penalty: e.repetitionPenalty }),
      ...(e.minChunkLength !== undefined && { min_chunk_length: e.minChunkLength }),
      ...(e.conditionOnPreviousChunks !== undefined && { condition_on_previous_chunks: e.conditionOnPreviousChunks }),
      ...(e.earlyStopThreshold !== undefined && { early_stop_threshold: e.earlyStopThreshold }),
    };
  }
}

export class FishAudioSDKService {
  private apiKey: string;
  private modelId: string;

  constructor() {
    const config = loadConfig();
    this.apiKey = config.apiKey;
    this.modelId = config.modelId;
  }

  private buildRequest(params: TTSParams, defaultFormat: 'mp3' | 'opus' = 'mp3'): ExtendedTTSRequest {
    const hasProsody =
      params.speed !== undefined ||
      params.volume !== undefined ||
      params.normalizeLoudness !== undefined;

    return new ExtendedTTSRequest(params.text, {
      referenceId: params.referenceId,
      referenceIds: params.referenceIds,
      format: params.format || defaultFormat,
      mp3Bitrate: params.mp3Bitrate,
      opusBitrate: params.opusBitrate as any,
      sampleRate: params.sampleRate,
      normalize: params.normalize !== false,
      // SDK type lags; the API accepts 'low' too.
      latency: (params.latency || 'balanced') as any,
      chunkLength: params.chunkLength,
      ...(hasProsody
        ? {
            prosody: {
              speed: params.speed ?? 1,
              volume: params.volume ?? 0,
            },
          }
        : {}),
      temperature: params.temperature,
      topP: params.topP,
      maxNewTokens: params.maxNewTokens,
      repetitionPenalty: params.repetitionPenalty,
      minChunkLength: params.minChunkLength,
      conditionOnPreviousChunks: params.conditionOnPreviousChunks,
      earlyStopThreshold: params.earlyStopThreshold,
      normalizeLoudness: params.normalizeLoudness,
    });
  }

  /**
   * Generate speech using standard HTTP API
   */
  async generateSpeech(params: TTSParams): Promise<TTSResponse> {
    try {
      const session = new Session(this.apiKey);
      const chunks: Buffer[] = [];

      const request = this.buildRequest(params, 'mp3');

      // Use the specified model
      const headers = { model: this.modelId };

      for await (const chunk of session.tts(request, headers)) {
        chunks.push(Buffer.from(chunk));
      }

      const audioBuffer = Buffer.concat(chunks);

      return {
        audio: audioBuffer,
        format: params.format || 'mp3'
      };
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Generate speech with streaming to file
   */
  async generateSpeechStream(params: TTSParams, outputPath: string): Promise<number> {
    try {
      const session = new Session(this.apiKey);
      const writeStream = createWriteStream(outputPath);
      let totalBytes = 0;

      const request = this.buildRequest(params, 'mp3');

      const headers = { model: this.modelId };

      for await (const chunk of session.tts(request, headers)) {
        const buffer = Buffer.from(chunk);
        totalBytes += buffer.length;
        writeStream.write(buffer);
      }

      writeStream.end();

      return totalBytes;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Generate speech using WebSocket for real-time streaming
   */
  async *generateSpeechWebSocket(
    params: TTSParams,
    textChunks: string[] | AsyncGenerator<string>
  ): AsyncGenerator<Buffer> {
    try {
      const ws = new WebSocketSession(this.apiKey);

      // Opus is preferred for streaming; build with empty text since WS streams it in chunks.
      const request = this.buildRequest({ ...params, text: '' }, 'opus');

      const headers = { model: this.modelId };

      // Convert array to async generator if needed
      const textGenerator = Array.isArray(textChunks) 
        ? this.arrayToAsyncGenerator(textChunks)
        : textChunks;

      for await (const audioChunk of ws.tts(request, textGenerator)) {
        yield Buffer.from(audioChunk);
      }
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Stream speech to a writable stream (for real-time playback)
   */
  async streamToPlayer(
    params: TTSParams,
    textChunks: string[] | AsyncGenerator<string>,
    playerStream: Writable
  ): Promise<number> {
    try {
      let totalBytes = 0;

      const audioStream = this.generateSpeechWebSocket(params, textChunks);

      for await (const chunk of audioStream) {
        totalBytes += chunk.length;
        playerStream.write(chunk);
      }

      playerStream.end();
      return totalBytes;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Helper to convert array to async generator
   */
  private async *arrayToAsyncGenerator(array: string[]): AsyncGenerator<string> {
    for (const item of array) {
      yield item;
    }
  }

  private handleError(error: any): FishAudioError {
    if (error?.response) {
      const status = error.response.status;
      const data = error.response.data;
      
      switch (status) {
        case 401:
          return new FishAudioError(
            'Invalid API key',
            ErrorCode.INVALID_API_KEY,
            data
          );
        case 400:
          return new FishAudioError(
            'Invalid request parameters',
            ErrorCode.INVALID_PARAMS,
            data
          );
        case 429:
          return new FishAudioError(
            'API quota exceeded',
            ErrorCode.QUOTA_EXCEEDED,
            data
          );
        case 500:
        case 502:
        case 503:
          return new FishAudioError(
            'Fish Audio server error',
            ErrorCode.SERVER_ERROR,
            data
          );
        default:
          return new FishAudioError(
            `API error: ${status}`,
            ErrorCode.UNKNOWN_ERROR,
            data
          );
      }
    }
    
    if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND') {
      return new FishAudioError(
        'Network error: Unable to reach Fish Audio API',
        ErrorCode.NETWORK_ERROR,
        { message: error.message }
      );
    }
    
    return new FishAudioError(
      error?.message || 'Unknown error occurred',
      ErrorCode.UNKNOWN_ERROR,
      { message: error?.message }
    );
  }
}