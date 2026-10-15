declare module 'sherpa-onnx-node' {
  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads: number; provider: string; debug: boolean });
    createStream(): { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void; inputFinished(): void; };
    isReady(stream: ReturnType<SpeakerEmbeddingExtractor['createStream']>): boolean;
    compute(stream: ReturnType<SpeakerEmbeddingExtractor['createStream']>, external?: boolean): Float32Array;
  }
}
