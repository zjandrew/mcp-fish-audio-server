import { FishAudioSDKService } from '../services/fishAudioSDK.js';
import { 
  TTSToolParams, 
  TTSToolResponse,
  TTSParams,
  AudioFormat,
  Mp3Bitrate,
  LatencyMode,
  FishAudioError
} from '../types/index.js';
import { loadConfig, getOutputPath } from '../utils/config.js';
import { writeFileSync, createWriteStream } from 'fs';
import { playAudio, isAudioPlaybackSupported } from '../utils/audioPlayer.js';
import { RealTimeAudioPlayer } from '../utils/realTimePlayer.js';
import { ReferenceSelector } from '../utils/referenceSelector.js';
import { logger } from '../utils/logger.js';

export class TTSTool {
  name = 'fish_audio_tts';
  description = 'Generate speech from text using Fish Audio TTS API';
  
  inputSchema = {
    type: 'object' as const,
    properties: {
      text: {
        type: 'string',
        description: 'Text to convert to speech',
        maxLength: 10000
      },
      reference_id: {
        type: 'string',
        description: 'Voice model reference ID (optional)'
      },
      reference_name: {
        type: 'string',
        description: 'Voice model name to search for (optional)'
      },
      reference_tag: {
        type: 'string',
        description: 'Voice model tag to search for (optional)'
      },
      streaming: {
        type: 'boolean',
        description: 'Enable HTTP streaming mode (optional)',
        default: false
      },
      websocket_streaming: {
        type: 'boolean',
        description: 'Enable WebSocket streaming mode (optional)',
        default: false
      },
      realtime_play: {
        type: 'boolean',
        description: 'Enable real-time audio playback during streaming (optional)',
        default: false
      },
      format: {
        type: 'string',
        enum: ['mp3', 'wav', 'pcm', 'opus'],
        description: 'Output audio format (optional)',
        default: 'mp3'
      },
      mp3_bitrate: {
        type: 'number',
        enum: [64, 128, 192],
        description: 'MP3 bitrate in kbps (optional)',
        default: 128
      },
      opus_bitrate: {
        type: 'number',
        enum: [-1000, 24000, 32000, 48000, 64000],
        description: 'Opus bitrate in bps; -1000 = auto. Only applies when format=opus.',
        default: -1000
      },
      sample_rate: {
        type: 'number',
        description: 'Audio sample rate in Hz. Defaults to format-native rate when omitted.'
      },
      normalize: {
        type: 'boolean',
        description: 'Enable text normalization (optional)',
        default: true
      },
      latency: {
        type: 'string',
        enum: ['low', 'normal', 'balanced'],
        description: 'Latency mode: low=lowest latency, balanced=reduced latency, normal=best quality',
        default: 'balanced'
      },
      output_path: {
        type: 'string',
        description: 'Custom output file path (optional)'
      },
      auto_play: {
        type: 'boolean',
        description: 'Automatically play the generated audio (optional)',
        default: false
      },
      speed: {
        type: 'number',
        description: 'Speaking rate multiplier (0.5=half speed, 1.0=normal, 2.0=double speed)',
        minimum: 0.5,
        maximum: 2.0,
        default: 1.0
      },
      volume: {
        type: 'number',
        description: 'Volume adjustment in dB (0=no change, positive=louder, negative=quieter)',
        default: 0
      },
      normalize_loudness: {
        type: 'boolean',
        description: 'Normalize output loudness for consistent perceived volume (s2-pro only)',
        default: true
      },
      temperature: {
        type: 'number',
        description: 'Expressiveness/emotion control (0=consistent and calm, 1=varied and emotional)',
        minimum: 0,
        maximum: 1,
        default: 0.7
      },
      top_p: {
        type: 'number',
        description: 'Nucleus sampling diversity (0..1)',
        minimum: 0,
        maximum: 1,
        default: 0.7
      },
      chunk_length: {
        type: 'number',
        description: 'Target text segment size for processing (100-300)',
        minimum: 100,
        maximum: 300,
        default: 300
      },
      max_new_tokens: {
        type: 'number',
        description: 'Maximum audio tokens to generate per text chunk',
        default: 1024
      },
      repetition_penalty: {
        type: 'number',
        description: 'Penalty for repeating audio patterns; values >1.0 reduce repetition',
        default: 1.2
      },
      min_chunk_length: {
        type: 'number',
        description: 'Minimum characters before splitting into a new chunk (0-100)',
        minimum: 0,
        maximum: 100,
        default: 50
      },
      condition_on_previous_chunks: {
        type: 'boolean',
        description: 'Use previous audio as context for voice consistency across chunks',
        default: true
      },
      early_stop_threshold: {
        type: 'number',
        description: 'Early stopping threshold for batch processing (0..1)',
        minimum: 0,
        maximum: 1,
        default: 1
      },
      speakers: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Multi-speaker mode (s2-pro only). Ordered list of speaker identifiers — each entry is resolved against FISH_REFERENCES by id, then name, then tag (or treated as a raw reference_id if no references are configured). The order maps to speaker tags `<|speaker:0|>`, `<|speaker:1|>`, ... in `text`. Provide at least 2 entries to engage multi-speaker; a single entry is equivalent to `reference_id`.'
      }
    },
    required: ['text']
  };

  private service: FishAudioSDKService;

  constructor() {
    this.service = new FishAudioSDKService();
  }

  async run(input: TTSToolParams): Promise<TTSToolResponse> {
    try {
      // Validate input
      if (!input.text || input.text.trim().length === 0) {
        return {
          success: false,
          error: 'Text input is required'
        };
      }

      if (input.text.length > 10000) {
        return {
          success: false,
          error: 'Text length exceeds maximum limit of 10,000 characters'
        };
      }

      const config = loadConfig();

      // Resolve speakers. Multi-speaker (s2-pro only) takes precedence when 2+ entries are given.
      let selectedReferenceId: string | undefined;
      let selectedReferenceIds: string[] | undefined;

      const selector = new ReferenceSelector(
        config.references || [],
        config.defaultReference
      );

      if (input.speakers && input.speakers.length > 0) {
        if (input.speakers.length > 1 && config.modelId !== 's2-pro') {
          return {
            success: false,
            error: `Multi-speaker synthesis requires the s2-pro model (current: ${config.modelId}). Set FISH_MODEL_ID=s2-pro.`,
          };
        }
        try {
          const ids = selector.selectMany(input.speakers);
          if (ids.length > 1) {
            selectedReferenceIds = ids;
          } else {
            selectedReferenceId = ids[0];
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to resolve speakers',
          };
        }
      } else if (input.reference_id || input.reference_name || input.reference_tag) {
        if (config.references && config.references.length > 0) {
          selectedReferenceId = selector.selectReference({
            id: input.reference_id,
            name: input.reference_name,
            tag: input.reference_tag,
          });

          if (!selectedReferenceId && (input.reference_name || input.reference_tag)) {
            return {
              success: false,
              error: `No reference found matching: ${input.reference_name || input.reference_tag}`,
            };
          }
        } else {
          // Fallback to direct ID if no references configured
          selectedReferenceId = input.reference_id;
        }
      } else {
        // Use default reference or backward compatible referenceId
        selectedReferenceId = config.defaultReference || config.referenceId;
      }
      
      // Prepare parameters
      const ttsParams: TTSParams & { streaming: boolean } = {
        text: input.text,
        referenceId: selectedReferenceId,
        referenceIds: selectedReferenceIds,
        format: (input.format || config.outputFormat) as AudioFormat,
        mp3Bitrate: (input.mp3_bitrate || config.mp3Bitrate) as Mp3Bitrate,
        opusBitrate: input.opus_bitrate,
        sampleRate: input.sample_rate,
        normalize: input.normalize !== false,
        latency: (input.latency || 'balanced') as LatencyMode,
        streaming: input.streaming ?? config.streaming,
        speed: input.speed,
        volume: input.volume,
        normalizeLoudness: input.normalize_loudness,
        temperature: input.temperature,
        topP: input.top_p,
        chunkLength: input.chunk_length,
        maxNewTokens: input.max_new_tokens,
        repetitionPenalty: input.repetition_penalty,
        minChunkLength: input.min_chunk_length,
        conditionOnPreviousChunks: input.condition_on_previous_chunks,
        earlyStopThreshold: input.early_stop_threshold,
      };

      // Determine output path
      const outputPath = input.output_path || getOutputPath(ttsParams.format || 'mp3');
      
      // Determine if auto-play is enabled
      const shouldAutoPlay = input.auto_play ?? config.autoPlay;
      
      // Determine if WebSocket streaming is enabled
      const useWebSocketStreaming = input.websocket_streaming ?? config.websocketStreaming;

      // WebSocket streaming mode with real-time playback
      if (useWebSocketStreaming) {
        return await this.handleWebSocketStreaming(input, ttsParams, outputPath, shouldAutoPlay || false);
      }
      
      if (ttsParams.streaming) {
        // HTTP Streaming mode
        const totalBytes = await this.service.generateSpeechStream(ttsParams, outputPath);

        // Auto-play if requested
        if (shouldAutoPlay && isAudioPlaybackSupported()) {
          try {
            await playAudio(outputPath);
          } catch (playError) {
            logger.error('Audio playback failed:', playError);
          }
        }

        return {
          success: true,
          file_path: outputPath,
          format: ttsParams.format,
          played: shouldAutoPlay || false
        };
      } else {
        // Non-streaming mode
        const response = await this.service.generateSpeech(ttsParams);
        
        // Save to file if output path is specified
        if (outputPath) {
          writeFileSync(outputPath, response.audio);
          
          // Auto-play if requested
          if (shouldAutoPlay && isAudioPlaybackSupported()) {
            try {
              await playAudio(outputPath);
            } catch (playError) {
              logger.error('Audio playback failed:', playError);
            }
          }
          
          return {
            success: true,
            file_path: outputPath,
            format: response.format,
            played: shouldAutoPlay || false
          };
        } else {
          // Return base64 encoded audio
          return {
            success: true,
            audio_data: response.audio.toString('base64'),
            format: response.format
          };
        }
      }
    } catch (error) {
      if (error instanceof FishAudioError) {
        return {
          success: false,
          error: `${error.message} (${error.code})`
        };
      }
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  private async handleWebSocketStreaming(
    input: TTSToolParams,
    ttsParams: TTSParams,
    outputPath: string,
    shouldAutoPlay: boolean
  ): Promise<TTSToolResponse> {
    const writeStream = outputPath ? createWriteStream(outputPath) : null;
    let realTimePlayer: RealTimeAudioPlayer | null = null;
    let totalBytes = 0;
    const audioChunks: Buffer[] = [];

    try {
      // Set up real-time player if requested
      const config = loadConfig();
      const shouldRealtimePlay = input.realtime_play ?? config.realtimePlay;
      
      if (shouldRealtimePlay && isAudioPlaybackSupported()) {
        realTimePlayer = new RealTimeAudioPlayer();
        realTimePlayer.start(ttsParams.format || 'opus');
      }

      // Split text into chunks for streaming
      const textChunks = this.splitTextIntoChunks(input.text);

      // Stream via WebSocket
      const audioStream = this.service.generateSpeechWebSocket(ttsParams, textChunks);

      for await (const audioChunk of audioStream) {
        totalBytes += audioChunk.length;
        
        // Write to file if output path specified
        if (writeStream) {
          writeStream.write(audioChunk);
        }
        
        // Play in real-time if requested
        if (realTimePlayer) {
          realTimePlayer.write(audioChunk);
        }
        
        // Collect chunks for post-playback if auto-play is enabled
        if (shouldAutoPlay && !shouldRealtimePlay) {
          audioChunks.push(audioChunk);
        }
      }

      // Close write stream
      if (writeStream) {
        writeStream.end();
      }

      // Stop real-time player
      if (realTimePlayer) {
        realTimePlayer.stop();
      }

      // Auto-play collected audio if requested (and not already played in real-time)
      let played = false;
      if (shouldAutoPlay && !shouldRealtimePlay && outputPath && isAudioPlaybackSupported()) {
        try {
          await playAudio(outputPath);
          played = true;
        } catch (playError) {
          logger.error('Audio playback failed:', playError);
        }
      } else if (shouldRealtimePlay) {
        played = true;
      }

      return {
        success: true,
        file_path: outputPath || undefined,
        format: ttsParams.format,
        played,
        streaming_mode: 'websocket',
        total_bytes: totalBytes
      };
    } catch (error) {
      // Clean up on error
      if (writeStream) {
        writeStream.end();
      }
      if (realTimePlayer) {
        realTimePlayer.stop();
      }
      throw error;
    }
  }

  private splitTextIntoChunks(text: string, chunkSize: number = 100): string[] {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const chunks: string[] = [];
    let currentChunk = '';

    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > chunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += sentence;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }
}