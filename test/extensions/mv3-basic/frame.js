parent.postMessage({ fromExtFrame: true, id: chrome.runtime.id, href: location.href, hasTabs: typeof chrome.tabs }, "*");
