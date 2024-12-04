import { 
  showNoZapsMessage
} from "./UIManager.js";
import { decodeIdentifier, isEventIdentifier } from "./utils.js";
import { ZAP_CONFIG as CONFIG, APP_CONFIG } from "./AppSettings.js";  // DIALOG_CONFIGを追加
import { statsManager } from "./StatsManager.js";
import { eventPool } from "./EventPool.js";  // パスを更新
import { cacheManager } from "./CacheManager.js";
import { profilePool } from "./ProfilePool.js"; // 追加: ProfilePoolからprofilePoolをインポート

class ZapSubscriptionManager {
  constructor() {
    this.configStore = new Map();
    this.observers = new Map();
  }

  setZapListUI(zapListUI) {
    this.zapListUI = zapListUI;
  }

  setViewConfig(viewId, config) {
    this.configStore.set(viewId, config);
  }

  getViewConfig(viewId) {
    return this.configStore.get(viewId);
  }

  // イベント処理を最適化した新しいメソッド
  async processZapEvent(event, viewId, shouldUpdateUI = true) {
    try {
      // まずイベントを表示
      if (shouldUpdateUI && this.zapListUI) {
        await this.zapListUI.appendZap(event);
      }

      // 参照情報とプロフィールは非同期で取得
      Promise.all([
        this.updateEventReference(event, viewId),
        statsManager.handleZapEvent(event, viewId),
        profilePool.verifyNip05Async(event.pubkey)
      ]).then(() => {
        // 参照情報が取得できたら該当要素を更新
        if (shouldUpdateUI && this.zapListUI && event.reference) {
          this.zapListUI.updateZapReference(event);
        }
      });

      return true;
    } catch (error) {
      console.error("Failed to process zap event:", error);
      return false;
    }
  }

  async handleZapEvent(event, viewId) {
    if (!cacheManager.addZapEvent(viewId, event)) return;
    await this.processZapEvent(event, viewId);
  }

  async updateEventReference(event, viewId) {
    try {
      const aTag = event.tags.find(tag => tag[0] === 'a');
      const eTag = event.tags.find(tag => tag[0] === 'e');
      const config = this.getViewConfig(viewId);
      
      if (!config?.relayUrls?.length) {
        console.warn("No relay URLs configured for reference fetch");
        return false;
      }

      const identifier = config?.identifier || '';
      if (isEventIdentifier(identifier)) return false;

      const fetchReference = async () => {
        let reference = null;
        if (aTag) {
          try {
            reference = await eventPool.fetchATagReference(config.relayUrls, aTag[1]);
          } catch (error) {
            console.warn("A-tag reference fetch failed:", aTag[1], error);
          }
        }
        
        if (!reference && eTag) {
          const eventId = eTag[1].toLowerCase();
          if (/^[0-9a-f]{64}$/.test(eventId)) {
            try {
              reference = await eventPool.fetchReference(config.relayUrls, eventId);
            } catch (error) {
              console.warn("E-tag reference fetch failed:", eTag[1], error);
            }
          }
        }
        return reference;
      };

      const reference = await cacheManager.getOrFetchReference(event.id, fetchReference);
      if (reference) {
        event.reference = reference;
        return true;
      }
      return false;

    } catch (error) {
      console.error("Reference fetch failed:", error, { eventId: event.id });
      return false;
    }
  }

  async updateEventReferenceBatch(events, viewId) {
    const config = this.getViewConfig(viewId);
    if (!config?.relayUrls?.length) return;

    const identifier = config?.identifier || '';
    if (isEventIdentifier(identifier)) return;

    // イベントごとにリファレンス情報を取得
    const fetchPromises = events.map(event => this.updateEventReference(event, viewId));
    await Promise.allSettled(fetchPromises);
  }

  // initializeSubscriptionsメソッドを最適化
  async initializeSubscriptions(config, viewId) {
    const decoded = decodeIdentifier(config.identifier);
    if (!decoded) throw new Error(CONFIG.ERRORS.DECODE_FAILED);

    cacheManager.updateLoadState(viewId, {
      isInitialFetchComplete: false,
      lastEventTime: null,
      isLoading: false
    });

    const batchEvents = [];
    let lastEventTime = null;

    // リファレンス情報の取得を効率化するための追跡
    let referencePromises = new Map();
    
    // バッチ処理時のキャッシュ更新を確実に
    const processBatch = async (events) => {
      if (events.length === 0) return;
      
      const sortedEvents = events.sort((a, b) => b.created_at - a.created_at);
      
      // まずキャッシュを更新
      sortedEvents.forEach(event => {
        cacheManager.addZapEvent(viewId, event);
      });

      // UIの更新とリファレンス情報の取得を並列化
      await Promise.all([
        // UIの更新（キャッシュから全イベントを取得）
        this.zapListUI?.batchUpdate(cacheManager.getZapEvents(viewId)),
        
        // リファレンス情報の取得
        ...sortedEvents.map(event => {
          if (!referencePromises.has(event.id)) {
            const promise = this.updateEventReference(event, viewId)
              .then(hasReference => {
                if (hasReference && this.zapListUI) {
                  this.zapListUI.updateZapReference(event);
                }
              });
            referencePromises.set(event.id, promise);
            return promise;
          }
          return referencePromises.get(event.id);
        }),

        // その他の処理
        Promise.all(sortedEvents.map(event => 
          Promise.all([
            statsManager.handleZapEvent(event, viewId),
            profilePool.verifyNip05Async(event.pubkey)
          ])
        ))
      ]);
    };

    // バッファ処理のインターバルを設定
    const bufferInterval = setInterval(() => {
      if (batchEvents.length > 0) {
        const eventsToProcess = batchEvents.splice(0);
        processBatch(eventsToProcess);
      }
    }, 500);

    return new Promise((resolve) => {
      eventPool.subscribeToZaps(viewId, config, decoded, {
        onevent: (event) => {
          lastEventTime = Math.min(lastEventTime || event.created_at, event.created_at);
          if (cacheManager.addZapEvent(viewId, event)) {
            batchEvents.push(event);
            
            if (batchEvents.length >= APP_CONFIG.BATCH_SIZE || 5) {
              const eventsToProcess = batchEvents.splice(0);
              processBatch(eventsToProcess);
            }
          }
        },
        oneose: async () => {
          clearInterval(bufferInterval);
          if (batchEvents.length > 0) {
            await processBatch(batchEvents);
          }
          this.finalizeInitialization(viewId, lastEventTime);
          resolve();
        }
      });
    });
  }

  // 新しいメソッド: 残りのリファレンス情報を更新
  async updateRemainingReferences(viewId) {
    const allEvents = cacheManager.getZapEvents(viewId);
    const eventsNeedingRefs = allEvents.filter(event => !event.reference);
    
    if (eventsNeedingRefs.length > 0) {
      this.updateEventReferenceBatch(eventsNeedingRefs, viewId).then(() => {
        eventsNeedingRefs.forEach(event => {
          if (event.reference && this.zapListUI) {
            this.zapListUI.updateZapReference(event);
          }
        });
      });
    }
  }

  // processBatchメソッドを最適化
  async processBatch(events, viewId) {
    try {
      // イベントを作成時刻でソート
      const sortedEvents = events.sort((a, b) => b.created_at - a.created_at);
      
      // キャッシュに追加（順序を維持）
      sortedEvents.forEach(event => {
        cacheManager.addZapEvent(viewId, event);
      });

      // UIを更新（キャッシュから全イベントを取得して表示）
      if (this.zapListUI) {
        const allEvents = cacheManager.getZapEvents(viewId);
        await this.zapListUI.batchUpdate(allEvents);
      }

      // 非同期処理を並列実行
      await Promise.all([
        this.updateEventReferenceBatch(sortedEvents, viewId),
        Promise.all(sortedEvents.map(event => {
          return Promise.all([
            statsManager.handleZapEvent(event, viewId),
            profilePool.verifyNip05Async(event.pubkey)
          ]);
        }))
      ]);

      // リファレンス情報の更新
      sortedEvents.forEach(event => {
        if (event.reference && this.zapListUI) {
          this.zapListUI.updateZapReference(event);
        }
      });
    } catch (error) {
      console.error("Failed to process batch:", error);
    }
  }

  async finalizeInitialization(viewId, lastEventTime) {
    cacheManager.updateLoadState(viewId, {
      isInitialFetchComplete: true,
      lastEventTime
    });

    const cachedEvents = cacheManager.getZapEvents(viewId);
    if (cachedEvents.length === 0) {
      showNoZapsMessage(viewId);
    } else if (cachedEvents.length >= APP_CONFIG.INITIAL_LOAD_COUNT) {
      this.setupInfiniteScroll(viewId);
    }
  }

  // loadMoreZaps method with improved error handling
  async loadMoreZaps(viewId) {
    const state = cacheManager.getLoadState(viewId);
    const config = this.getViewConfig(viewId);

    if (!this.canLoadMore(state, config)) return 0;

    try {
      state.isLoading = true;
      return await this.executeLoadMore(viewId, state, config);
    } catch (error) {
      console.error('[ZapManager] 追加ロード失敗:', error);
      return 0;
    } finally {
      state.isLoading = false;
    }
  }

  canLoadMore(state, config) {
    return config && !state.isLoading && state.lastEventTime;
  }

  async executeLoadMore(viewId, state, config) {
    const decoded = decodeIdentifier(config.identifier, state.lastEventTime);
    if (!decoded) return 0;

    let newEventsCount = 0;
    const newEvents = [];

    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Load timeout'));
        }, APP_CONFIG.LOAD_TIMEOUT || 10000);

        eventPool.subscribeToZaps(viewId, config, decoded, {
          onevent: async (event) => {
            if (event.created_at < state.lastEventTime) {
              newEvents.push(event);
              newEventsCount++;
              state.lastEventTime = Math.min(state.lastEventTime, event.created_at);
            }
          },
          oneose: () => {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      // 新しいイベントをソートして表示
      if (newEventsCount > 0) {
        newEvents.sort((a, b) => b.created_at - a.created_at);
        
        // キャッシュから既存の参照情報を取得
        const eventRefs = newEvents.map(event => ({
          event,
          reference: cacheManager.getReference(event.id)
        }));

        // まず先にイベントを表示
        for (const { event, reference } of eventRefs) {
          cacheManager.addZapEvent(viewId, event);
          if (reference) {
            event.reference = reference;
          }
          await this.processZapEvent(event, viewId);
        }

        // 参照情報がないイベントのみ非同期で取得
        const eventsNeedingRefs = eventRefs
          .filter(({ reference }) => !reference)
          .map(({ event }) => event);

        if (eventsNeedingRefs.length > 0) {
          this.updateEventReferenceBatch(eventsNeedingRefs, viewId);
        }
      }

      return newEventsCount;

    } catch (error) {
      console.error('[ZapManager] 追加ロード処理エラー:', error);
      return 0;
    }
  }

  // インフィニットスクロールの処理を改善
  setupInfiniteScroll(viewId) {
    const list = this.getListElement(viewId);
    if (!list || this.observers?.get(viewId)) return;

    const trigger = this.createScrollTrigger();
    list.appendChild(trigger);

    const observer = this.createIntersectionObserver(viewId, trigger, list);
    observer.observe(trigger);
    this.observers.set(viewId, observer);
  }

  getListElement(viewId) {
    const dialog = document.querySelector(`nzv-dialog[data-view-id="${viewId}"]`);
    return dialog?.shadowRoot?.querySelector('.dialog-zap-list');
  }

  createScrollTrigger() {
    const trigger = document.createElement('div');
    trigger.className = 'load-more-trigger';
    return trigger;
  }

  createIntersectionObserver(viewId, trigger, list) {
    let isLoading = false;
    let debounceTimer = null;

    return new IntersectionObserver(
      async (entries) => {
        const entry = entries[0];
        if (!entry.isIntersecting || isLoading) return;

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          if (isLoading) return; // 二重チェック
          
          try {
            isLoading = true;
            const loadedCount = await this.loadMoreZaps(viewId);
            
            if (loadedCount === 0) {
              this.cleanupInfiniteScroll(viewId, trigger);
            }
          } catch (error) {
            console.error('[ZapManager] 追加ロード実行エラー:', error);
          } finally {
            isLoading = false;
          }
        }, 300); // デバウンス時間を増やして安定性を向上
      },
      {
        root: list,
        rootMargin: APP_CONFIG.INFINITE_SCROLL.ROOT_MARGIN,
        threshold: APP_CONFIG.INFINITE_SCROLL.THRESHOLD
      }
    );
  }

  cleanupInfiniteScroll(viewId, trigger) {
    const observer = this.observers.get(viewId);
    if (observer) {
      observer.disconnect();
      trigger.remove();
      this.observers.delete(viewId);
    }
  }
}

// ZapSubscriptionManager を初期化する際に zapListUI を設定
const subscriptionManager = new ZapSubscriptionManager();
export { subscriptionManager };
