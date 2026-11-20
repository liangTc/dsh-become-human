import {BlockAssembler} from '@deepseek-ai/dsh-llm';

// Human consumes visible text only. Keep protocol statistics separate from
// message content so a reasoning block can never be mistaken for a reply.
export class ModelStreamOutput {
  #blocks = new BlockAssembler();
  #reasoning = new Map();
  streamCounts = {text:0, reasoning:0, finish:0, usage:0, other:0};
  textDeltaChars = 0;
  finalTextChars = 0;

  push(chunk) {
    // Older delta-only adapters omit the index. A single visible text block
    // can still be finalized by a subsequent indexed block-end at index 0.
    const index = chunk.index ?? 0;
    switch (chunk.type) {
      case 'text-delta':
        this.streamCounts.text++;
        if (typeof chunk.text === 'string') {
          this.textDeltaChars += chunk.text.length;
          this.#blocks.push({type:'text-delta', index, text:chunk.text});
        }
        break;
      case 'reasoning-delta':
        this.streamCounts.reasoning++;
        if (typeof chunk.text === 'string') {
          const previous = this.#reasoning.get(index);
          if (!previous?.closed) this.#reasoning.set(index, {length:(previous?.length ?? 0) + chunk.text.length});
        }
        break;
      case 'finish':
      case 'usage':
        this.streamCounts[chunk.type]++;
        break;
      default:
        this.streamCounts.other++;
        if (chunk.type === 'block-start' && chunk.blockType === 'text') {
          this.#blocks.push({type:'block-start', index, blockType:'text'});
        }
        if (chunk.type === 'block-end') {
          const block = chunk.block;
          if (block?.type === 'text' && typeof block.text === 'string') {
            this.finalTextChars += block.text.length;
            this.#blocks.push({type:'block-end', index, block});
          }
          if (block?.type === 'reasoning' && typeof block.text === 'string' && !this.#reasoning.get(index)?.closed) {
            this.#reasoning.set(index, {length:block.text.length, closed:true});
          }
        }
    }
  }

  get text() {
    return this.#blocks.blocks().map(block => block.text).join('');
  }

  get reasoningChars() {
    let length = 0;
    for (const block of this.#reasoning.values()) length += block.length;
    return length;
  }

  facts(text) {
    return {textChars:text.length, reasoningChars:this.reasoningChars, textDeltaChars:this.textDeltaChars,
      finalTextChars:this.finalTextChars, streamCounts:this.streamCounts};
  }
}
