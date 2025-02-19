import { APP_CONFIG } from './AppSettings';

export class BatchProcessor {
  constructor(options = {}) {
    this._validateOptions(options);
    this._initializeProperties(options);
  }

  _validateOptions(options) {
    if (!options.pool?.ensureRelay) {
      throw new Error('Invalid pool object: ensureRelay method is required');
    }
  }

  _initializeProperties(options) {
    this.pool = options.pool;
    this.batchSize = options.batchSize || APP_CONFIG.BATCH_PROCESSOR_CONFIG.DEFAULT_BATCH_SIZE;
    this.batchDelay = options.batchDelay || APP_CONFIG.BATCH_PROCESSOR_CONFIG.DEFAULT_BATCH_DELAY;
    this.relayUrls = options.relayUrls || APP_CONFIG.BATCH_PROCESSOR_CONFIG.DEFAULT_RELAY_URLS;
    
    this.batchQueue = new Set();
    this.pendingFetches = new Map();
    this.resolvers = new Map();
    this.processingItems = new Set();
    this.batchTimer = null;

    this.eventCache = new Map();
    this.maxCacheAge = options.maxCacheAge || APP_CONFIG.BATCH_PROCESSOR_CONFIG.DEFAULT_MAX_CACHE_AGE;
  }

  getOrCreateFetchPromise(key) {
    if (this.pendingFetches.has(key)) {
      return this.pendingFetches.get(key);
    }

    const promise = new Promise(resolve => {
      this.resolvers.set(key, resolve);
    });
    this.pendingFetches.set(key, promise);
    this.batchQueue.add(key);
    this._scheduleBatchProcess();
    return promise;
  }

  _scheduleBatchProcess() {
    if (this.batchTimer) return;

    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this._processBatchQueue();
    }, this.batchDelay);
  }

  async _processBatchQueue() {
    if (this.batchQueue.size === 0) return;

    const batchItems = this._getBatchItems();
    await this._processBatch(batchItems);
    
    // _scheduleNextBatchの代わりに直接次のバッチをスケジュール
    if (this.batchQueue.size > 0) {
      this._scheduleBatchProcess();
    }
  }

  _getBatchItems() {
    const batchItems = Array.from(this.batchQueue).slice(0, this.batchSize);
    batchItems.forEach(item => {
      this.batchQueue.delete(item);
      this.processingItems.add(item);
    });
    return batchItems;
  }

  async _processBatch(batchItems) {
    try {
      await this.onBatchProcess(batchItems);
    } catch (error) {
      this._handleBatchError(batchItems, error);
    } finally {
      this._cleanupBatchItems(batchItems);
    }
  }

  _handleBatchError(items, error) {
    console.error(`${this.constructor.name} batch processing error:`, error);
    items.forEach(item => this.resolveItem(item, null));
  }

  _cleanupBatchItems(items) {
    items.forEach(key => {
      this.processingItems.delete(key);
      this.pendingFetches.delete(key);
      this.resolvers.delete(key);
    });
  }

  resolveItem(key, result) {
    const resolver = this.resolvers.get(key);
    if (resolver) {
      resolver(result);
      this.resolvers.delete(key);
    }
  }

  // Override these methods in derived classes
  async onBatchProcess(_items) {
    throw new Error("onBatchProcess must be implemented by derived class");
  }

  onBatchError(items, error) {
    console.error(`Batch processing error in ${this.constructor.name}:`, error);
    items.forEach(item => this.resolveItem(item, null));
  }

  // 共通の_cleanup処理を基底クラスに移動
  _cleanup(timeoutId, sub, items, processedItems) {
    clearTimeout(timeoutId);
    if (sub) sub.close();
    items.forEach(item => {
      if (!processedItems.has(item) && this.resolvers.has(item)) {
        this.resolveItem(item, null);
      }
    });
  }

  // プール参照を抽象化
  _getSubscriptionPool() {
    return this.pool;
  }

  // 共通のプロミスベースの処理を抽象化
  async _createSubscriptionPromise(items, relayUrls, filter, eventHandler) {
    if (!relayUrls?.length) {
      items.forEach(id => this.resolveItem(id, null));
      return;
    }

    return new Promise((resolve) => {
      const processedItems = new Set();
      const timeoutDuration = APP_CONFIG.BATCH_PROCESSOR_CONFIG.TIMEOUT_DURATION;
      let isCompleted = false;
      let timeoutId;
      let sub;

      const cleanup = () => {
        if (isCompleted) return;
        isCompleted = true;

        if (timeoutId) clearTimeout(timeoutId);
        if (sub) sub.close();

        items.forEach(item => {
          if (!processedItems.has(item)) {
            this.resolveItem(item, null);
          }
        });
        resolve();
      };

      const checkCompletion = () => {
        if (processedItems.size === items.length) {
          cleanup();
        }
      };

      sub = this.pool.subscribeMany(
        relayUrls,
        filter,
        {
          onevent: (event) => {
            try {
              if (!isCompleted) {
                eventHandler(event, processedItems);
                checkCompletion();
              }
            } catch (error) {
              console.error('Event handler error:', error);
            }
          },
          oneose: () => {
            // oneoseが呼ばれる前に最終チェックを行う
            setTimeout(cleanup, 100);
          },
          onerror: (error) => {
            console.error('Subscription error:', error);
          }
        }
      );

      timeoutId = setTimeout(() => {
        if (!isCompleted) {
          console.warn('Subscription timeout');
          cleanup();
        }
      }, timeoutDuration);
    });
  }

  setRelayUrls(urls) {
    this.relayUrls = Array.isArray(urls) ? urls : [];
  }

  // キャッシュ関連メソッドの改善
  getCachedItem(key) {
    const cached = this.eventCache.get(key);
    if (!this._isValidCache(cached)) {
      this.eventCache.delete(key);
      return null;
    }
    return cached.event;
  }

  _isValidCache(cached) {
    if (!cached) return false;
    return (Date.now() - cached.timestamp) <= this.maxCacheAge;
  }

  setCachedItem(key, event) {
    this.eventCache.set(key, {
      event,
      timestamp: Date.now()
    });
  }
}

export class ETagReferenceProcessor extends BatchProcessor {
  constructor(options = {}) {
    super(options);
  }

  async onBatchProcess(items) {
    if (!items?.length) return;

    const filter = [{
      ids: items.slice(0, this.batchSize)
    }];

    const eventHandler = (event, processedItems) => {
      if (items.includes(event.id)) {
        const cachedEvent = this.getCachedItem(event.id);
        if (!cachedEvent || event.created_at > cachedEvent.created_at) {
          this.setCachedItem(event.id, event);
          this.resolveItem(event.id, event);
          processedItems.add(event.id);
        }
      }
    };

    await this._createSubscriptionPromise(items, this.relayUrls, filter, eventHandler);
  }
}

export class ATagReferenceProcessor extends BatchProcessor {
  constructor(options = {}) {
    super(options);
  }

  _parseAtagValue(targetEventId) {
    const parts = targetEventId.split(':');
    if (parts.length !== 3) return null;

    return {
      kind: parseInt(parts[0]),
      pubkey: parts[1],
      identifier: parts[2]
    };
  }

  async onBatchProcess(items) {
    if (!items?.length) return;

    const validItems = [];
    const filterConditions = {
      kinds: [],
      authors: [],
      '#d': []
    };

    items.slice(0, this.batchSize).forEach(targetEventId => {
      const parsed = this._parseAtagValue(targetEventId);
      if (parsed) {
        filterConditions.kinds.push(parsed.kind);
        filterConditions.authors.push(parsed.pubkey);
        filterConditions['#d'].push(parsed.identifier);
        validItems.push(targetEventId);
      } else {
        this.resolveItem(targetEventId, null);
      }
    });

    if (validItems.length === 0) return;

    const filter = [filterConditions];

    const eventHandler = (event, processedItems) => {
      const targetEventId = validItems.find(item => {
        const parsed = this._parseAtagValue(item);
        return parsed && 
               event.kind === parsed.kind && 
               event.pubkey === parsed.pubkey &&
               event.tags.some(t => t[0] === 'd' && t[1] === parsed.identifier);
      });

      if (targetEventId) {
        const cachedEvent = this.getCachedItem(targetEventId);
        if (!cachedEvent || event.created_at > cachedEvent.created_at) {
          this.setCachedItem(targetEventId, event);
          this.resolveItem(targetEventId, event);
          processedItems.add(targetEventId);
        }
      }
    };

    await this._createSubscriptionPromise(validItems, this.relayUrls, filter, eventHandler);
  }
}

export class ProfileProcessor extends BatchProcessor {
  constructor(options = {}) {
    const { simplePool, config } = options;
    super({
      pool: simplePool,
      batchSize: config.BATCH_SIZE || APP_CONFIG.PROFILE_CONFIG.BATCH_SIZE,
      batchDelay: config.BATCH_DELAY || APP_CONFIG.PROFILE_CONFIG.BATCH_DELAY,
      relayUrls: config.RELAYS || APP_CONFIG.PROFILE_CONFIG.RELAYS,
      maxCacheAge: APP_CONFIG.BATCH_PROCESSOR_CONFIG.DEFAULT_MAX_CACHE_AGE,
    });
    this.config = config;
  }

  async onBatchProcess(pubkeys) {
    if (!this.config.RELAYS?.length) {
      throw new Error('No relays configured for profile fetch');
    }

    const uncachedPubkeys = pubkeys.filter(pubkey => {
      const cached = this.getCachedItem(pubkey);
      if (cached) {
        this.resolveItem(pubkey, cached);
        return false;
      }
      return true;
    });

    if (uncachedPubkeys.length === 0) return;

    const filter = [{
      kinds: [0],
      authors: uncachedPubkeys
    }];

    const latestEvents = new Map();

    const eventHandler = (event, processedItems) => {
      const currentEvent = latestEvents.get(event.pubkey);
      if (!currentEvent || event.created_at > currentEvent.created_at) {
        latestEvents.set(event.pubkey, event);
        this.setCachedItem(event.pubkey, event);
      }
      processedItems.add(event.pubkey);
    };

    try {
      await this._createSubscriptionPromise(
        uncachedPubkeys,
        this.config.RELAYS,
        filter,
        eventHandler
      );

      uncachedPubkeys.forEach(pubkey => {
        const latestEvent = latestEvents.get(pubkey);
        this.resolveItem(pubkey, latestEvent || null);
      });

    } catch (error) {
      console.error("Profile fetch error:", error);
      this.onBatchError(pubkeys, error);
    }
  }
}