declare module 'nostr-zap-view' {
  export interface ViewerConfigType {
    relayUrls: string[];
    pubkey?: string;
    noteId?: string;
    colorMode?: boolean;
  }

  export class ViewerConfig {
    static fromButton(button: HTMLButtonElement): ViewerConfigType | null;
  }

  export interface ProfilePool {
    fetchProfiles(pubkeys: string[]): Promise<void>;
  }

  export interface EventPool {
    connectToRelays(urls: string[]): Promise<void>;
  }

  export interface SubscriptionManager {
    setViewConfig(viewId: string, config: ViewerConfigType): void;
    setupInfiniteScroll(viewId: string): void;
    initializeSubscriptions(config: ViewerConfigType, viewId: string): Promise<void>;
  }

  export interface StatsManager {
    initializeStats(identifier: string, viewId: string, initialize: boolean): Promise<void>;
  }

  export interface CacheManager {
    getZapEvents(viewId: string): any[];
    processCachedData(viewId: string, config: ViewerConfigType): Promise<{
      hasEnoughCachedEvents: boolean;
    }>;
  }

  export const profilePool: ProfilePool;
  export const eventPool: EventPool;
  export const APP_CONFIG: any;
  export const cacheManager: CacheManager;
  export const subscriptionManager: SubscriptionManager;
  export const statsManager: StatsManager;

  export function initialize(options?: Record<string, any>): void;
  export function nostrZapView(options?: Record<string, any>): void;
}
