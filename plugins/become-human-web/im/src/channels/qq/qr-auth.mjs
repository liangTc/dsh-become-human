export class QqQrAuth {
  #start;
  #source;

  constructor({ start, source = 'deepseek-harness' } = {}) {
    if (start !== undefined && typeof start !== 'function') throw new TypeError('QQ QR connector is invalid');
    this.#start = start;
    this.#source = source;
  }

  start(callbacks, { signal } = {}) {
    if (!callbacks || typeof callbacks.onSuccess !== 'function'
      || typeof callbacks.onFailure !== 'function') {
      throw new TypeError('QQ QR callbacks are required');
    }
    const options = {
      displayQrCodeToConsole: false,
      source: this.#source,
      signal,
    };
    if (this.#start) return this.#start(callbacks, options);

    // Keep the synchronous disposer contract expected by QqController. Loading
    // the separately licensed connector happens only after QR login is chosen;
    // normal Host startup and manual AppID binding do not load it.
    let disposed = false;
    let release;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      signal?.removeEventListener('abort', dispose);
      if (typeof release === 'function') release();
    };
    signal?.addEventListener('abort', dispose, {once: true});
    if (signal?.aborted) { dispose(); return dispose; }
    import('@tencent-connect/qqbot-connector').catch(cause => {
      if (cause?.code !== 'ERR_MODULE_NOT_FOUND' && cause?.code !== 'MODULE_NOT_FOUND') throw cause;
      const error = new Error('QQ_QR_CONNECTOR_NOT_INSTALLED: the optional QQ QR connector is not distributed. Use manual AppID / AppSecret binding.', {cause});
      error.code = 'QQ_QR_CONNECTOR_NOT_INSTALLED';
      throw error;
    }).then(module => {
      if (disposed || signal?.aborted) return;
      if (typeof module.startQrConnect !== 'function') throw new TypeError('QQ QR connector has no startQrConnect function');
      release = module.startQrConnect(callbacks, options);
      if (disposed && typeof release === 'function') release();
    }).catch(error => {
      if (!disposed && !signal?.aborted) callbacks.onFailure(error);
    });
    return dispose;
  }
}
