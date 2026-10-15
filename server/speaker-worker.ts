/// <reference lib="webworker" />
import { SpeakerEmbeddingExtractor } from 'sherpa-onnx-node';
const extractor = new SpeakerEmbeddingExtractor({ model: process.env.VOICEPRINT_MODEL || 'data/models/speaker.onnx', numThreads: 2, provider: 'cpu', debug: false });
self.onmessage = (event: MessageEvent<{ id: number; samples: Float32Array }>) => {
  const { id, samples } = event.data;
  try {
    const stream = extractor.createStream(); stream.acceptWaveform({ samples, sampleRate: 16000 }); stream.inputFinished();
    if (!extractor.isReady(stream)) throw new Error('录音太短或没有有效语音');
    const embedding = Array.from(extractor.compute(stream, false));
    if (!embedding.length || !embedding.every(Number.isFinite)) throw new Error('声纹模型返回无效特征');
    self.postMessage({ id, embedding });
  } catch (e) { self.postMessage({ id, error: e instanceof Error ? e.message : '声纹提取失败' }); }
};
