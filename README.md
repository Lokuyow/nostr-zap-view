# nostr-zap-view
[![NPM](https://img.shields.io/npm/v/nostr-zap-view.svg)](https://www.npmjs.com/package/nostr-zap-view)

View any Nostr Zaps from anywhere, supporting npub, nprofile, note, nevent, and naddr identifiers.

Example page: https://lokuyow.github.io/nostr-zap-view/

## Usage

To configure a button for displaying zap information, use the following attributes:

- `data-title`: (Optional) Custom title for the zap dialog. If left empty, the identifier will be used as the title.
- `data-nzv-id`: The Nostr identifier (npub, nprofile, note, nevent or naddr) for which zap information will be displayed.
- `data-zap-color-mode`: (Optional) Enable or disable color mode for zap amounts. Set to "true" to enable and "false" to disable.
- `data-relay-urls`: Comma-separated list of relay URLs to fetch zap information from.

```html
<button
  data-title=""
  data-nzv-id="npub1a3pvwe2p3v7mnjz6hle63r628wl9w567aw7u23fzqs062v5vqcqqu3sgh3"
  data-zap-color-mode="true"
  data-relay-urls="wss://relay.nostr.band,wss://relay.damus.io,wss://nos.lol,wss://nostr.bitcoiner.social,wss://relay.nostr.wirednet.jp,wss://yabu.me">
  View zaps 👀
</button>
```

Add this script tag right before the bottom closing body tag.
```js
<script src="https://cdn.jsdelivr.net/npm/nostr-zap-view@1"></script>
```

## Usage in Svelte

First, install from npm:

```sh
npm i nostr-zap-view
```

Then use in your Svelte component:

```svelte
<script lang="ts">
    import { onMount, tick } from "svelte";
    import { nostrZapView } from "nostr-zap-view";

    export let show = false;

    $: if (show) {
        (async () => {
            await tick();
            nostrZapView();
        })();
    }
</script>

<button
  data-title=""
  data-nzv-id="naddr1..."
  data-zap-color-mode="true"
  data-relay-urls="wss://relay.example.com">
  View
</button>
```

## Related repository
- [nostr-zap](https://github.com/SamSamskies/nostr-zap) ![stars](https://img.shields.io/github/stars/SamSamskies/nostr-zap.svg?style=social) - Zap any Nostr npub or note from anywhere.