class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions || {};
    this.targetSampleRate = config.targetSampleRate || 16000;
    this.chunkSamples = config.chunkSamples || 3200;
    this.step = sampleRate / this.targetSampleRate;
    this.position = 0;
    this.samples = [];
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.emitChunk();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  emitChunk() {
    if (!this.samples.length) return;
    const pcm = new ArrayBuffer(this.samples.length * 2);
    const view = new DataView(pcm);
    for (let index = 0; index < this.samples.length; index += 1) {
      const value = Math.max(-1, Math.min(1, this.samples[index]));
      view.setInt16(index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    }
    this.samples = [];
    this.port.postMessage({ type: "pcm", pcm }, [pcm]);
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    let squareTotal = 0;
    for (const value of channel) squareTotal += value * value;
    this.port.postMessage({ type: "level", value: Math.sqrt(squareTotal / channel.length) });

    while (this.position < channel.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const next = Math.min(index + 1, channel.length - 1);
      this.samples.push(channel[index] + (channel[next] - channel[index]) * fraction);
      if (this.samples.length === this.chunkSamples) this.emitChunk();
      this.position += this.step;
    }
    this.position -= channel.length;
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
