import { poolManager } from "./ZapPool.js";
import { initializeZapPlaceholders, replacePlaceholderWithZap, prependZap, showDialog, displayZapStats, renderZapListFromCache, initializeZapStats, showNoZapsMessage } from "./UIManager.js";
import { decodeIdentifier, isProfileIdentifier, isEventIdentifier } from "./utils.js"; // isEventIdentifierを追加
import { ZapConfig, ZAP_CONFIG as CONFIG } from "./ZapConfig.js";
import { statsManager } from "./StatsManager.js";

class ZapSubscriptionManager {
  constructor() {
    this.viewStates = new Map(); // 各ビューの状態を管理
    this.configStore = new Map(); // 設定を保存するためのMap
  }

  getOrCreateViewState(viewId) {
    if (!this.viewStates.has(viewId)) {
      this.viewStates.set(viewId, {
        zapEventsCache: [],
        zapStatsCache: new Map(),
        isInitialFetchComplete: false,
        currentStats: null
      });
    }
    return this.viewStates.get(viewId);
  }

  // 新しいメソッド: configを保存
  setViewConfig(viewId, config) {
    this.configStore.set(viewId, config);
  }

  // 新しいメソッド: configを取得
  getViewConfig(viewId) {
    return this.configStore.get(viewId);
  }

  clearCache(viewId) {
    const state = this.getOrCreateViewState(viewId);
    state.zapEventsCache = [];
    state.currentStats = null;  // Fix: currentStats����クリア
  }

  async handleZapEvent(event, maxCount, viewId) {
    const state = this.getOrCreateViewState(viewId);
    if (!state.zapEventsCache.some((e) => e.id === event.id)) {
      event.isRealTimeEvent = false;
      
      // Add reference handling before UI updates
      await this.updateEventReference(event, viewId);

      state.zapEventsCache.push(event);
      state.zapEventsCache.sort((a, b) => b.created_at - a.created_at);

      try {
        const index = state.zapEventsCache.findIndex((e) => e.id === event.id);
        if (index < maxCount) {
          await replacePlaceholderWithZap(event, index, viewId);
          await new Promise(resolve => setTimeout(resolve, 50));
          await renderZapListFromCache(state.zapEventsCache, maxCount, viewId);
        }
      } catch (error) {
        console.error("Failed to update Zap display:", error);
      }

      if (state.zapEventsCache.length >= maxCount) {
        poolManager.closeSubscription(viewId, 'zap');
      }
    }
  }

  async handleRealTimeEvent(event, viewId) {
    const state = this.getOrCreateViewState(viewId);
    if (!state.isInitialFetchComplete) return;

    if (!state.zapEventsCache.some((e) => e.id === event.id)) {
      event.isRealTimeEvent = true;
      event.isStatsCalculated = false;

      try {
        // reference情報の取得を待機
        await this.updateEventReference(event, viewId);
        
        // 統計情報の更新
        await this.updateEventStats(event, state, viewId);

        // キャッシュに追加とUI更新（referenceが取得済みの状態で）
        state.zapEventsCache.unshift(event);
        await prependZap(event, viewId);
      } catch (error) {
        console.error("Failed to handle realtime Zap event:", error);
      }
    }
  }

  async updateEventStats(event, state, viewId) {
    const bolt11Tag = event.tags.find((tag) => tag[0].toLowerCase() === "bolt11")?.[1];
    if (bolt11Tag) {
      const decoded = window.decodeBolt11(bolt11Tag);
      const amountMsats = parseInt(decoded.sections.find(section => section.name === "amount")?.value ?? "0", 10);

      if (amountMsats > 0) {
        state.currentStats = state.currentStats || { count: 0, msats: 0, maxMsats: 0 };
        const updatedStats = await statsManager.incrementStats(state.currentStats, amountMsats, viewId);
        state.currentStats = updatedStats;
        displayZapStats(updatedStats, viewId);
        event.isStatsCalculated = true;
        event.amountMsats = amountMsats;
      }
    }
  }

  async updateEventReference(event, viewId) {
    const eTag = event.tags.find(tag => tag[0] === 'e');
    const config = this.getViewConfig(viewId);
    
    // Identifierがnote1またはnevent1の場合は参照情報を取得しない
    const identifier = config?.identifier || '';
    if (isEventIdentifier(identifier)) {
      return false;
    }

    if (eTag && config?.relayUrls) {
      try {
        const reference = await poolManager.fetchReference(config.relayUrls, eTag[1]);
        if (reference) {
          event.reference = reference;
          return true;
        }
      } catch (error) {
        console.error("Failed to fetch reference:", error);
      }
    }
    return false;
  }

  async initializeSubscriptions(config, viewId) {
    const decoded = decodeIdentifier(config.identifier, config.maxCount);
    if (!decoded) throw new Error(CONFIG.ERRORS.DECODE_FAILED);

    this.setViewConfig(viewId, config);
    const state = this.getOrCreateViewState(viewId);
    state.isInitialFetchComplete = false;

    // 統計情報の取得を非同期で開始
    statsManager.getZapStats(config.identifier, viewId)
      .then(stats => {
        state.currentStats = stats;
        if (!stats?.error) {
          displayZapStats(stats, viewId);
        }
      });

    return new Promise((resolve) => {
      poolManager.subscribeToZaps(viewId, config, decoded, {
        onevent: async (event) => {
          await this.handleZapEvent(event, config.maxCount, viewId);
        },
        oneose: () => {
          state.isInitialFetchComplete = true;
          this.initializeRealTimeSubscription(config, viewId);
          resolve();
        }
      });
    });
  }

  initializeRealTimeSubscription(config, viewId) {
    const decoded = decodeIdentifier(config.identifier, CONFIG.DEFAULT_LIMIT);
    if (!decoded) throw new Error(CONFIG.ERRORS.DECODE_FAILED);

    poolManager.subscribeToRealTime(viewId, config, decoded, {
      onevent: (event) => this.handleRealTimeEvent(event, viewId),
      oneose: () => console.log("Received EOSE for real-time Zap.")
    });
  }

  async handleCachedZaps(viewId, config) {
    const viewState = this.getOrCreateViewState(viewId);
    try {
      const stats = await statsManager.getZapStats(config.identifier, viewId);
      const updatedStats = !stats?.error 
        ? await statsManager.recalculateStats(stats, viewState.zapEventsCache)
        : { timeout: stats.timeout };
      
      displayZapStats(updatedStats, viewId);
      await renderZapListFromCache(viewState.zapEventsCache, config.maxCount, viewId);
    } catch (error) {
      console.error("Failed to handle cached zaps:", error);
      displayZapStats({ timeout: true }, viewId);
    }
  }
}

const subscriptionManager = new ZapSubscriptionManager();

export async function fetchLatestZaps(event) {
  const button = event.currentTarget;
  const viewId = button.getAttribute("data-zap-view-id");
  
  try {
    if (!viewId) throw new Error("Missing view ID");
    const zapDialog = document.querySelector(`nzv-dialog[data-view-id="${viewId}"]`);
    if (!zapDialog) throw new Error(CONFIG.ERRORS.DIALOG_NOT_FOUND);

    const config = ZapConfig.fromButton(button);
    subscriptionManager.setViewConfig(viewId, config);
    const viewState = subscriptionManager.getOrCreateViewState(viewId);
    const hasCache = viewState.zapEventsCache.length > 0;

    showDialog(viewId);

    if (hasCache) {
      await renderZapListFromCache(viewState.zapEventsCache, config.maxCount, viewId);
      if (viewState.currentStats) {
        displayZapStats(viewState.currentStats, viewId);
      }
    } else {
      subscriptionManager.clearCache(viewId);
      await initializeNewFetch(viewId, config);
    }

    if (viewState.zapEventsCache.length === 0 && viewState.isInitialFetchComplete) {
      showNoZapsMessage(viewId);
    }
  } catch (error) {
    console.error("Error occurred while fetching Zaps:", error);
    displayZapStats({ timeout: true }, viewId);
  }
}

async function initializeNewFetch(viewId, config) {
  initializeZapPlaceholders(config.maxCount, viewId);
  initializeZapStats(viewId);  // スケルトン表示を即時実行

  await subscriptionManager.initializeSubscriptions(config, viewId);
}
