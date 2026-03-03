# TTS Parameters Enhancement Design

Date: 2026-03-03

## Goal

Add speed, volume, and temperature controls to the MCP TTS tool, then publish as `@zjandrew/fish-audio-mcp-server` on npm.

## Technical Context

- `fish-audio-sdk` natively supports `prosody: { speed, volume }` in `TTSRequest`
- `fish-audio-sdk` does NOT support `temperature` — but `Session.tts()` sends `request.toJSON()` as plain JSON to `/v1/tts`, so extending `toJSON()` is trivial
- Fish Audio API supports `temperature` (0–1, controls expressiveness), `prosody.speed` (0.5–2.0), `prosody.volume` (dB adjustment)

## New MCP Tool Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `speed` | number | 1.0 | 0.5–2.0 | Speaking rate multiplier |
| `volume` | number | 0 | dB | Volume adjustment (positive=louder, negative=quieter) |
| `temperature` | number | 0.7 | 0–1 | Expressiveness (0=calm/consistent, 1=varied/emotional) |

## Approach: SDK Native + toJSON Extension

### ExtendedTTSRequest

Subclass `TTSRequest` to inject `temperature` into the JSON payload. `prosody` is handled natively by the SDK.

```typescript
class ExtendedTTSRequest extends TTSRequest {
  private _temperature?: number;
  constructor(text: string, options: TTSRequestOptions & { temperature?: number }) {
    const { temperature, ...sdkOptions } = options;
    super(text, sdkOptions);
    this._temperature = temperature;
  }
  toJSON() {
    return {
      ...super.toJSON(),
      ...(this._temperature !== undefined && { temperature: this._temperature }),
    };
  }
}
```

### Files to Change

1. **`src/types/index.ts`** — Add `speed`, `volume`, `temperature` to `TTSParams` and `TTSToolParams`
2. **`src/services/fishAudioSDK.ts`** — Add `ExtendedTTSRequest` class; pass `prosody` and `temperature` in all three generation methods
3. **`src/tools/tts.ts`** — Add 3 parameters to `inputSchema`; pass them through in `run()`
4. **`package.json`** — Change name to `@zjandrew/fish-audio-mcp-server`, bump version to `0.7.0`

### Data Flow

```
MCP tool input (speed, volume, temperature)
  → TTSTool.run() maps to { prosody: { speed, volume }, temperature }
  → ExtendedTTSRequest({ prosody, temperature, ...existing })
  → toJSON() outputs { ..., prosody: { speed, volume }, temperature }
  → SDK sends JSON to Fish Audio API
```

## npm Publishing

- Package: `@zjandrew/fish-audio-mcp-server`
- Version: `0.7.0` (minor bump — new features, backward compatible)
- Update README with new parameters documentation
